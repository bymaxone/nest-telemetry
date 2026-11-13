import {
  clearHandle,
  clearPendingStart,
  createHandle,
  currentHandle,
  pendingStart,
  setPendingStart,
  shutdownTelemetry
} from './handle'
import { startTelemetry } from './start'

const mockSdkInstance = {
  start: jest.fn<void, []>(),
  shutdown: jest.fn<Promise<void>, []>()
}
const mockNodeSdk = jest.fn((..._args: unknown[]) => mockSdkInstance)
const mockBatchSpanProcessor = jest.fn((..._args: unknown[]) => ({ kind: 'batch' }))
const mockOtlpExporter = jest.fn((..._args: unknown[]) => ({ kind: 'exporter' }))
const mockAutoInstrumentations = jest.fn((..._args: unknown[]) => ['instrumentation'])
const mockResourceFromAttributes = jest.fn((..._args: unknown[]) => ({ kind: 'resource' }))

jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: function (...args: unknown[]) {
    return mockNodeSdk(...args)
  }
}))
jest.mock('@opentelemetry/sdk-trace', () => ({
  BatchSpanProcessor: function (...args: unknown[]) {
    return mockBatchSpanProcessor(...args)
  }
}))
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: function (...args: unknown[]) {
    return mockOtlpExporter(...args)
  }
}))
jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: (...args: unknown[]) => mockAutoInstrumentations(...args)
}))
jest.mock('@opentelemetry/resources', () => {
  const detector = (name: string): { name: string; detect: () => { attributes: object } } => ({
    name,
    detect: () => ({
      attributes: { [`${name}.id`]: 1, 'process.command_args': ['node', '--api-key=secret'] }
    })
  })
  return {
    resourceFromAttributes: (...args: unknown[]) => mockResourceFromAttributes(...args),
    envDetector: detector('env'),
    hostDetector: detector('host'),
    osDetector: detector('os'),
    processDetector: detector('process'),
    serviceInstanceIdDetector: detector('serviceinstance')
  }
})

beforeEach(() => {
  mockSdkInstance.shutdown.mockResolvedValue(undefined)
})

afterEach(() => {
  clearHandle()
  clearPendingStart()
})

describe('startTelemetry', () => {
  describe('when disabled', () => {
    it('returns a disabled handle and loads no SDK package when the host says so', async () => {
      // Scenario: enabled:false is the host's policy; nothing is constructed or started.
      const handle = await startTelemetry({ enabled: false, env: {} })
      expect(handle.enabled).toBe(false)
      expect(mockNodeSdk).not.toHaveBeenCalled()
      expect(mockResourceFromAttributes).not.toHaveBeenCalled()
      expect(currentHandle()).toBeUndefined()
      await expect(handle.shutdown()).resolves.toBeUndefined()
    })

    it('is disabled by the standard OTEL_SDK_DISABLED switch when the host is silent', async () => {
      // Scenario: preloading turns the SDK on and OTEL_SDK_DISABLED=true turns it off.
      const handle = await startTelemetry({ env: { OTEL_SDK_DISABLED: 'true' } })
      expect(handle.enabled).toBe(false)
      expect(mockNodeSdk).not.toHaveBeenCalled()
    })

    it('stays disabled even when a handle is already registered', async () => {
      // Scenario: a disabled start never hands back the running handle.
      await startTelemetry({ env: {} })
      const disabled = await startTelemetry({ enabled: false, env: {} })
      expect(disabled.enabled).toBe(false)
    })
  })

  describe('when enabled', () => {
    it.each([
      [undefined, undefined, true],
      [true, undefined, true],
      [false, undefined, false],
      [undefined, 'true', false],
      [true, 'true', false],
      [false, 'true', false]
    ])(
      'with enabled=%p and OTEL_SDK_DISABLED=%p the SDK started is %p',
      async (enabled, disabled, started) => {
        // Scenario: the host's policy and the operator's standard kill switch, in every
        // combination. The SDK starts only when neither says no, so an operator can always turn
        // tracing off whatever the code passes.
        const handle = await startTelemetry({
          ...(enabled === undefined ? {} : { enabled }),
          env: disabled === undefined ? {} : { OTEL_SDK_DISABLED: disabled }
        })
        expect(handle.enabled).toBe(started)
        expect(mockSdkInstance.start).toHaveBeenCalledTimes(started ? 1 : 0)
      }
    )

    it('assembles the SDK from the options and the environment', async () => {
      // Scenario: one boot wires resource, redaction processor, batch processor and
      // instrumentations in the order that makes redaction run first.
      const predicate = (): boolean => true
      await startTelemetry({
        serviceName: 'api',
        serviceVersion: '1.0.0',
        ignoreIncomingRequest: predicate,
        env: { OTEL_BSP_SCHEDULE_DELAY: '250' }
      })
      expect(mockResourceFromAttributes).toHaveBeenCalledWith({
        'service.name': 'api',
        'service.version': '1.0.0'
      })
      expect(mockOtlpExporter).toHaveBeenCalledWith()
      expect(mockBatchSpanProcessor).toHaveBeenCalledWith({
        exporter: { kind: 'exporter' },
        scheduledDelayMillis: 250
      })
      expect(mockAutoInstrumentations).toHaveBeenCalledWith(
        expect.objectContaining({
          '@opentelemetry/instrumentation-http': expect.objectContaining({
            ignoreIncomingRequestHook: predicate
          })
        })
      )
      const config = mockNodeSdk.mock.calls[0] as unknown as [Record<string, unknown>]
      const [options] = config
      expect(options['resource']).toEqual({ kind: 'resource' })
      expect(options['instrumentations']).toEqual([['instrumentation']])
      expect(options['metricReaders']).toEqual([])
      expect(options['logRecordProcessors']).toEqual([])
      const processors = options['spanProcessors'] as { onEnding?: unknown; kind?: string }[]
      expect(processors).toHaveLength(2)
      expect(typeof processors[0]?.onEnding).toBe('function')
      expect(processors[1]).toEqual({ kind: 'batch' })
      expect(mockSdkInstance.start).toHaveBeenCalledTimes(1)
    })

    it('leaves metrics and logs to the SDK when the environment names their exporters', async () => {
      // Scenario: no override keys are spread when the operator asked for the signal.
      await startTelemetry({
        env: { OTEL_METRICS_EXPORTER: 'otlp', OTEL_LOGS_EXPORTER: 'otlp' }
      })
      const [options] = mockNodeSdk.mock.calls[0] as unknown as [Record<string, unknown>]
      expect(options).not.toHaveProperty('metricReaders')
      expect(options).not.toHaveProperty('logRecordProcessors')
    })

    it('omits the redacting processor and warns when URL redaction is opted out', async () => {
      // Scenario: the explicit opt-out removes the processor and says so on the warning channel.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      await startTelemetry({ serviceName: 'api', unsafe: { disableUrlRedaction: true }, env: {} })
      const [options] = mockNodeSdk.mock.calls[0] as unknown as [Record<string, unknown>]
      expect(options['spanProcessors']).toEqual([{ kind: 'batch' }])
      expect(emitWarning).toHaveBeenCalledTimes(1)
    })

    it('warns once about the missing service name, and not when a name is given', async () => {
      // Scenario: a start with no name warns, with the library code; a start that names the
      // service does not.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      await startTelemetry({ env: {} })
      expect(emitWarning).toHaveBeenCalledTimes(1)
      expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('No service name is set'), {
        type: 'Warning',
        code: 'BYMAX_TELEMETRY_SERVICE_NAME_MISSING'
      })
      clearHandle()
      emitWarning.mockClear()
      await startTelemetry({ serviceName: 'api', env: {} })
      expect(emitWarning).not.toHaveBeenCalled()
    })

    it('does not warn when nothing is opted out', async () => {
      // Scenario: the default boot is silent.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      await startTelemetry({ serviceName: 'api', env: {} })
      expect(emitWarning).not.toHaveBeenCalled()
    })

    it('starts with no arguments, reading the process environment', async () => {
      // Scenario: the zero-argument form, as a bare preload calls it, uses the defaults.
      const handle = await startTelemetry()
      expect(handle.enabled).toBe(true)
    })

    it('starts one SDK when two calls overlap', async () => {
      // Scenario: a preload and an application bootstrap that do not await each other both call
      // start while the dynamic imports are still pending; only one SDK may start.
      const [first, second] = await Promise.all([
        startTelemetry({ env: {} }),
        startTelemetry({ env: {} })
      ])
      expect(second).toBe(first)
      expect(mockNodeSdk).toHaveBeenCalledTimes(1)
      expect(mockSdkInstance.start).toHaveBeenCalledTimes(1)
    })

    it('joins a start that another copy of the module began', async () => {
      // Scenario: an ESM preload and a CommonJS application each load their own copy of the
      // library and share only globalThis. The other copy's start is in progress there, so this
      // copy hands back its handle and builds nothing.
      const otherHandle = createHandle(() => Promise.resolve())
      setPendingStart(Promise.resolve(otherHandle))
      const handle = await startTelemetry({ env: {} })
      expect(handle).toBe(otherHandle)
      expect(mockNodeSdk).not.toHaveBeenCalled()
    })

    it('publishes its own start where another copy can join it', async () => {
      // Scenario: while this copy is loading, the registry holds the start another copy would join.
      const starting = startTelemetry({ env: {} })
      const published = pendingStart()
      expect(published).toBeDefined()
      expect(await published).toBe(await starting)
      expect(pendingStart()).toBeUndefined()
    })

    it('starts again after a start that failed', async () => {
      // Scenario: a failed start must not leave the in-flight marker behind and block every later
      // attempt.
      mockNodeSdk.mockImplementationOnce(() => {
        throw new Error('constructor failed')
      })
      await expect(startTelemetry({ env: {} })).rejects.toThrow('constructor failed')
      const handle = await startTelemetry({ env: {} })
      expect(handle.enabled).toBe(true)
    })

    it('selects the resource detectors and removes the process command line by default', async () => {
      // Scenario: the five built-in detectors run in the SDK's default order, and what the process
      // detector reports no longer includes the command-line arguments.
      await startTelemetry({ env: {} })
      const [options] = mockNodeSdk.mock.calls[0] as unknown as [
        { resourceDetectors: { detect: () => { attributes: Record<string, unknown> } }[] }
      ]
      const reports = options.resourceDetectors.map((detector) => detector.detect().attributes)
      expect(reports.map((attributes) => Object.keys(attributes)[0])).toEqual([
        'serviceinstance.id',
        'process.id',
        'host.id',
        'os.id',
        'env.id'
      ])
      expect(reports[1]).not.toHaveProperty(['process.command_args'])
    })

    it('honours OTEL_NODE_RESOURCE_DETECTORS and keeps the command line on explicit opt-in', async () => {
      // Scenario: the operator selects only the process detector, and the host exports the command
      // line on purpose.
      jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      await startTelemetry({
        env: { OTEL_NODE_RESOURCE_DETECTORS: 'process' },
        unsafe: { exportProcessCommandArgs: true }
      })
      const [options] = mockNodeSdk.mock.calls[0] as unknown as [
        { resourceDetectors: { detect: () => { attributes: Record<string, unknown> } }[] }
      ]
      expect(options.resourceDetectors).toHaveLength(1)
      expect(options.resourceDetectors[0]?.detect().attributes).toHaveProperty([
        'process.command_args'
      ])
    })

    it('registers the handle for the application to drain', async () => {
      // Scenario: the preload starts the SDK and the application finds it through the registry.
      const handle = await startTelemetry({ env: {} })
      expect(currentHandle()).toBe(handle)
    })

    it('returns the running handle when started a second time', async () => {
      // Scenario: a second preload or a repeated call must not start a second SDK.
      const first = await startTelemetry({ env: {} })
      const second = await startTelemetry({ env: {} })
      expect(second).toBe(first)
      expect(mockNodeSdk).toHaveBeenCalledTimes(1)
    })
  })

  describe('when the SDK is already running', () => {
    const IGNORED = 'BYMAX_TELEMETRY_OPTIONS_IGNORED'

    it('warns once that the options of a later call were ignored, and returns the running handle', async () => {
      // Scenario: an application passes its policy to a start that arrives after the preload's. The
      // first start's options stand, so the host is told its own were dropped rather than left to
      // find out from a span that carries what it asked to keep out.
      const first = await startTelemetry({ serviceName: 'api', env: {} })
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const second = await startTelemetry({
        serviceName: 'other',
        unsafe: { disableUrlRedaction: true },
        extraRedactedQueryParams: ['x'],
        env: {}
      })
      expect(second).toBe(first)
      expect(emitWarning).toHaveBeenCalledTimes(1)
      expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('options ignored'), {
        type: 'Warning',
        code: IGNORED
      })
      expect(mockNodeSdk).toHaveBeenCalledTimes(1)
    })

    it.each([
      [undefined],
      [{}],
      // A host that spreads optional configuration into the call leaves unset keys as undefined.
      [Object.defineProperty({}, 'serviceName', { value: undefined, enumerable: true })]
    ])('stays silent when a later call passes no defined option (%p)', async (options) => {
      // Scenario: a bare second start, as a library might make to be sure telemetry is on, has
      // nothing to ignore, so it says nothing.
      await startTelemetry({ serviceName: 'api', env: {} })
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      await startTelemetry(options)
      expect(emitWarning).not.toHaveBeenCalled()
    })

    it('warns when a call joins a start that is still loading', async () => {
      // Scenario: two overlapping calls share one start; the second one's options are dropped too.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const [first, second] = await Promise.all([
        startTelemetry({ serviceName: 'api', env: {} }),
        startTelemetry({ serviceName: 'other', env: {} })
      ])
      expect(second).toBe(first)
      expect(emitWarning).toHaveBeenCalledTimes(1)
      expect(emitWarning).toHaveBeenCalledWith(expect.any(String), {
        type: 'Warning',
        code: IGNORED
      })
    })

    it('warns when a call joins a start that another copy of the module began', async () => {
      // Scenario: the copy that started is not this one; its options are still the ones in force.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      setPendingStart(Promise.resolve(createHandle(() => Promise.resolve())))
      await startTelemetry({ serviceName: 'api', env: {} })
      expect(emitWarning).toHaveBeenCalledTimes(1)
    })

    it('says that enabled:false does not stop a running SDK, and leaves it running', async () => {
      // Scenario: a host that asks for telemetry off after it started gets a disabled handle, but
      // the SDK keeps exporting; the warning names the call that does stop it.
      const running = await startTelemetry({ serviceName: 'api', env: {} })
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const handle = await startTelemetry({ enabled: false, env: {} })
      expect(handle.enabled).toBe(false)
      expect(emitWarning).toHaveBeenCalledTimes(1)
      expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('does not stop the SDK'), {
        type: 'Warning',
        code: IGNORED
      })
      expect(emitWarning.mock.calls[0]?.[0]).toContain('shutdownTelemetry()')
      expect(currentHandle()).toBe(running)
      expect(mockSdkInstance.shutdown).not.toHaveBeenCalled()
    })

    it('says that enabled:false does not stop an SDK that is still loading', async () => {
      // Scenario: the SDK a start is still building is already running as far as the host can tell.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const starting = startTelemetry({ serviceName: 'api', env: {} })
      await startTelemetry({ enabled: false, env: {} })
      await starting
      expect(emitWarning).toHaveBeenCalledTimes(1)
      expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('does not stop the SDK'), {
        type: 'Warning',
        code: IGNORED
      })
    })

    it('says the options were ignored when OTEL_SDK_DISABLED turns a later call off', async () => {
      // Scenario: the operator's switch reaches a call made after the SDK started. It returns a
      // disabled handle and leaves the SDK running, so the host hears that its options did nothing.
      const running = await startTelemetry({ serviceName: 'api', env: {} })
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const handle = await startTelemetry({ env: { OTEL_SDK_DISABLED: 'true' } })
      expect(handle.enabled).toBe(false)
      expect(emitWarning).toHaveBeenCalledTimes(1)
      expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('options ignored'), {
        type: 'Warning',
        code: IGNORED
      })
      expect(currentHandle()).toBe(running)
    })

    it('stays silent when OTEL_SDK_DISABLED turns off a later call that passes no option', async () => {
      // Scenario: a bare call under the process-wide switch has nothing to ignore.
      await startTelemetry({ serviceName: 'api', env: {} })
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      process.env['OTEL_SDK_DISABLED'] = 'true'
      try {
        const handle = await startTelemetry()
        expect(handle.enabled).toBe(false)
      } finally {
        delete process.env['OTEL_SDK_DISABLED']
      }
      expect(emitWarning).not.toHaveBeenCalled()
    })

    it('stays silent when enabled:false meets no running SDK', async () => {
      // Scenario: turning telemetry off before anything started is ordinary, not a surprise.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      await startTelemetry({ enabled: false, env: {} })
      expect(emitWarning).not.toHaveBeenCalled()
    })

    it('does not count an SDK that is already stopping as running', async () => {
      // Scenario: a start that arrives during a flush waits for it and builds a fresh SDK, so its
      // options are used, not ignored, and the warning would be wrong.
      const running = await startTelemetry({ serviceName: 'api', env: {} })
      let release: () => void = () => undefined
      mockSdkInstance.shutdown.mockReturnValue(new Promise<void>((resolve) => (release = resolve)))
      const flushing = running.shutdown()
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const restarted = startTelemetry({ serviceName: 'next', env: {} })
      release()
      await flushing
      await restarted
      expect(emitWarning).not.toHaveBeenCalled()
      expect(mockNodeSdk).toHaveBeenCalledTimes(2)
    })

    it('says that enabled:false does not stop an SDK that is stopping', async () => {
      // Scenario: during a flush there is no running SDK to keep, so a host that asks for
      // telemetry off is not told it failed to stop one.
      const running = await startTelemetry({ serviceName: 'api', env: {} })
      let release: () => void = () => undefined
      mockSdkInstance.shutdown.mockReturnValue(new Promise<void>((resolve) => (release = resolve)))
      const flushing = running.shutdown()
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      await startTelemetry({ enabled: false, env: {} })
      expect(emitWarning).not.toHaveBeenCalled()
      release()
      await flushing
    })
  })

  describe('shutdown', () => {
    it('waits for a start in progress and then drains the SDK it started', async () => {
      // Scenario: a shutdown arrives while the packages are still loading; with no handle yet it
      // must not resolve and leave the SDK to start afterwards with nobody to stop it.
      const starting = startTelemetry({ env: {} })
      const stopping = shutdownTelemetry()
      await Promise.all([starting, stopping])
      expect(mockSdkInstance.start).toHaveBeenCalledTimes(1)
      expect(mockSdkInstance.shutdown).toHaveBeenCalledTimes(1)
      expect(currentHandle()).toBeUndefined()
    })

    it('does not fail a shutdown because the start it waited for failed', async () => {
      // Scenario: the start in progress throws; the shutdown has nothing to drain and resolves,
      // and the failure belongs to the caller of start.
      mockNodeSdk.mockImplementationOnce(() => {
        throw new Error('constructor failed')
      })
      const starting = startTelemetry({ env: {} })
      const stopping = shutdownTelemetry()
      await expect(starting).rejects.toThrow('constructor failed')
      await expect(stopping).resolves.toBeUndefined()
    })

    it('stops the SDK once and clears the registry', async () => {
      // Scenario: the handle flushes the SDK and later calls are no-ops.
      const handle = await startTelemetry({ env: {} })
      await handle.shutdown()
      await handle.shutdown()
      expect(mockSdkInstance.shutdown).toHaveBeenCalledTimes(1)
      expect(currentHandle()).toBeUndefined()
    })

    it('is reachable through shutdownTelemetry', async () => {
      // Scenario: the application drains the SDK it never constructed.
      await startTelemetry({ env: {} })
      await shutdownTelemetry()
      expect(mockSdkInstance.shutdown).toHaveBeenCalledTimes(1)
    })

    it('propagates a failed flush and does not retry it', async () => {
      // Scenario: the collector refuses the final export; the caller decides what that means, and
      // a second call does not flush twice.
      mockSdkInstance.shutdown.mockRejectedValueOnce(new Error('refused'))
      const handle = await startTelemetry({ env: {} })
      await expect(handle.shutdown()).rejects.toThrow('refused')
      await expect(handle.shutdown()).resolves.toBeUndefined()
      expect(mockSdkInstance.shutdown).toHaveBeenCalledTimes(1)
    })

    it('waits for a flush in progress before starting a new SDK', async () => {
      // Scenario: a start arrives while the previous SDK is still flushing; it must not be handed
      // the handle that is stopping, and must not start before the flush ends.
      let finish = (): void => undefined
      mockSdkInstance.shutdown.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve
          })
      )
      const first = await startTelemetry({ env: {} })
      const flush = first.shutdown()
      const restarted = startTelemetry({ env: {} })
      await new Promise((resolve) => setImmediate(resolve))
      expect(mockNodeSdk).toHaveBeenCalledTimes(1)
      finish()
      await flush
      const second = await restarted
      expect(second).not.toBe(first)
      expect(mockNodeSdk).toHaveBeenCalledTimes(2)
    })

    it('starts a new SDK after a flush in progress fails', async () => {
      // Scenario: the flush that a start was waiting on fails; the start still proceeds, and the
      // failure belongs to the caller that asked for the flush.
      let fail = (_error: Error): void => undefined
      mockSdkInstance.shutdown.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            fail = reject
          })
      )
      const first = await startTelemetry({ env: {} })
      const flush = first.shutdown()
      const restarted = startTelemetry({ env: {} })
      await new Promise((resolve) => setImmediate(resolve))
      fail(new Error('refused'))
      await expect(flush).rejects.toThrow('refused')
      await expect(restarted).resolves.toMatchObject({ enabled: true })
      expect(mockNodeSdk).toHaveBeenCalledTimes(2)
    })
  })
})
