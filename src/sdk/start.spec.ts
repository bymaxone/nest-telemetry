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
      await startTelemetry({ unsafe: { disableUrlRedaction: true }, env: {} })
      const [options] = mockNodeSdk.mock.calls[0] as unknown as [Record<string, unknown>]
      expect(options['spanProcessors']).toEqual([{ kind: 'batch' }])
      expect(emitWarning).toHaveBeenCalledTimes(1)
    })

    it('does not warn when nothing is opted out', async () => {
      // Scenario: the default boot is silent.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      await startTelemetry({ env: {} })
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
