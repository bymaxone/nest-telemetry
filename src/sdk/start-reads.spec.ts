/**
 * @fileoverview Tests that `startTelemetry` reads each option the steps of a start share once, and
 * that a warning about a turned-off redaction agrees with the redaction the SDK applies, with the SDK
 * packages replaced by doubles.
 * @layer sdk
 */
import { clearHandle, clearPendingStart, currentHandle } from './handle'
import { startTelemetry } from './start'
import type { TelemetryOptions } from './types'

const mockSdkInstance = {
  start: jest.fn<void, []>(),
  shutdown: jest.fn<Promise<void>, []>()
}
const mockNodeSdk = jest.fn((..._args: unknown[]) => mockSdkInstance)
const mockBatchSpanProcessor = jest.fn((..._args: unknown[]) => ({ kind: 'batch' }))
const mockOtlpExporter = jest.fn((..._args: unknown[]) => ({
  kind: 'exporter',
  export: jest.fn((_spans: unknown, done: (result: { code: number }) => void) => done({ code: 1 }))
}))
const mockAutoInstrumentations = jest.fn((..._args: unknown[]) => ['instrumentation'])
const mockResourceFromAttributes = jest.fn((..._args: unknown[]) => ({ kind: 'resource' }))
const mockWinstonTransportCheck = jest.fn((..._args: unknown[]) => undefined)

jest.mock('./winston-transport', () => ({
  warnAboutMissingWinstonTransport: (...args: unknown[]) => mockWinstonTransportCheck(...args)
}))

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
      attributes: {
        [`${name}.id`]: 1,
        'process.command_args': ['node', '--api-key=secret'],
        'process.command': 'SECRET-FIRST-ARG'
      }
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

describe('startTelemetry reads each option once', () => {
  describe('when enabled', () => {
    it('reads the unsafe options once in a start', async () => {
      // Scenario: an options object whose `unsafe` is a getter answers a different object each time, as
      // a computed or lazy option can. The warning about turned-off redactions, the SDK build and the
      // instrumentation config share one read, so what a warning announces is what the SDK applies.
      jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      let reads = 0
      const options: TelemetryOptions = {
        env: {},
        get unsafe() {
          reads += 1
          return { exportHostId: true as const }
        }
      }
      await startTelemetry(options)
      expect(reads).toBe(1)
    })

    it.each(['serviceName', 'serviceVersion'])('reads %s once in a start', async (field) => {
      // Scenario: the identity of the service is a getter that answers differently on each read. The
      // warning about a missing name and the resource share one read, so they cannot disagree.
      jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      let reads = 0
      const options = { env: {} } as TelemetryOptions
      Object.defineProperty(options, field, {
        enumerable: true,
        get: () => {
          reads += 1
          return 'real'
        }
      })
      await startTelemetry(options)
      expect(reads).toBe(1)
    })

    it('warns about a missing service name exactly when the resource has none, for a name that changes', async () => {
      // Scenario: the first read of `serviceName` is blank and later ones are 'real'. With one read the
      // start sees the blank name: it warns and exports unknown_service:node, so the warning is about the
      // very name the resource carries.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      let reads = 0
      const options: TelemetryOptions = {
        env: {},
        get serviceName() {
          reads += 1
          return reads === 1 ? '' : 'real'
        }
      }
      await startTelemetry(options)
      const [attributes] = mockResourceFromAttributes.mock.calls[0] as unknown as [
        Record<string, string>
      ]
      const warned = emitWarning.mock.calls.some(
        ([, details]) =>
          (details as { code?: string }).code === 'BYMAX_TELEMETRY_SERVICE_NAME_MISSING'
      )
      expect(warned).toBe(true)
      expect(attributes['service.name']).toBe('unknown_service:node')
    })

    it.each([
      ['unsafe', 'disableUrlRedaction', true],
      ['unsafe', 'disableRedisArgumentRedaction', true],
      ['unsafe', 'exportProcessCommandArgs', true],
      ['unsafe', 'exportHostId', true],
      ['instrumentations', 'fs', true],
      ['instrumentations', 'sendLogs', true],
      ['instrumentations', 'overrides', {}]
    ])('reads %s.%s once in a start', async (option, field, value) => {
      // Scenario: a field of the option is a getter that answers differently on each read. Every step of
      // a start (the warning, the SDK build, the instrumentation config) must work from one read of the
      // field, so the warning and the effect cannot disagree, even for a getter that has state.
      jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      let reads = 0
      const inner = {}
      Object.defineProperty(inner, field, {
        enumerable: true,
        get: () => {
          reads += 1
          return value
        }
      })
      await startTelemetry({ env: {}, [option]: inner } as TelemetryOptions)
      expect(reads).toBe(1)
    })

    it('warns about exactly the redactions it applies when a field of unsafe answers differently each time', async () => {
      // Scenario: the first read of `unsafe.exportHostId` is absent and later ones are `true`. With one
      // read the start sees it absent: no warning and no host id exported. Reading it per step would
      // warn about nothing while the SDK exported the machine identifier.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      let reads = 0
      const unsafe = {
        get exportHostId() {
          reads += 1
          return reads === 1 ? undefined : (true as const)
        }
      }
      await startTelemetry({ env: {}, unsafe } as TelemetryOptions)
      const [sdkOptions] = mockNodeSdk.mock.calls[0] as unknown as [
        { resourceDetectors: { detect: () => { attributes: Record<string, unknown> } }[] }
      ]
      const hostWarnings = emitWarning.mock.calls.filter(([text]) =>
        /Host id redaction is disabled/.test(String(text))
      )
      expect(hostWarnings).toHaveLength(0)
      expect(sdkOptions.resourceDetectors[2]?.detect().attributes).not.toHaveProperty(['host.id'])
      expect(reads).toBe(1)
    })

    it('warns about the host id and exports it when the field answers true on its first read', async () => {
      // Scenario: the mirror of the row above, so both halves of the agreement are pinned: a field that
      // answers `true` on the first read is warned about and exported.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      let reads = 0
      const unsafe = {
        get exportHostId() {
          reads += 1
          return reads === 1 ? (true as const) : undefined
        }
      }
      await startTelemetry({ env: {}, unsafe } as TelemetryOptions)
      const [sdkOptions] = mockNodeSdk.mock.calls[0] as unknown as [
        { resourceDetectors: { detect: () => { attributes: Record<string, unknown> } }[] }
      ]
      const hostWarnings = emitWarning.mock.calls.filter(([text]) =>
        /Host id redaction is disabled/.test(String(text))
      )
      expect(hostWarnings).toHaveLength(1)
      expect(sdkOptions.resourceDetectors[2]?.detect().attributes).toHaveProperty(['host.id'])
    })

    it('warns about exactly the redactions it turns off when the unsafe getter answers differently each time', async () => {
      // Scenario: the first read of `unsafe` is empty and later ones turn every redaction off. With one
      // read the start sees the empty object: nothing is warned about and nothing is exported. Reading
      // it per step would warn about nothing while the SDK exported the host id.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      let reads = 0
      const options: TelemetryOptions = {
        env: {},
        get unsafe() {
          reads += 1
          return reads === 1
            ? {}
            : {
                exportHostId: true as const,
                exportProcessCommandArgs: true as const,
                disableUrlRedaction: true as const,
                disableRedisArgumentRedaction: true as const
              }
        }
      }
      await startTelemetry(options)
      const [sdkOptions] = mockNodeSdk.mock.calls[0] as unknown as [
        {
          resourceDetectors: { detect: () => { attributes: Record<string, unknown> } }[]
          spanProcessors: unknown[]
        }
      ]
      const redactionWarnings = emitWarning.mock.calls.filter(([text]) =>
        /redaction is disabled/.test(String(text))
      )
      expect(redactionWarnings).toHaveLength(0)
      expect(sdkOptions.resourceDetectors[2]?.detect().attributes).not.toHaveProperty(['host.id'])
      // The URL redactor stays ahead of the batch processor.
      expect(sdkOptions.spanProcessors).toHaveLength(2)
      expect(reads).toBe(1)
    })

    it.each([
      ['instrumentations', { sendLogs: false }],
      ['extraRedactedQueryParams', ['sid']],
      ['ignoreIncomingRequest', () => false]
    ])('reads the %s option once in a start', async (key, value) => {
      // Scenario: an option that is a getter answers differently on each read. The warning about a
      // missing winston transport and the instrumentation config both need `instrumentations`, and the
      // config reads the other two; each must come from one read, so the warning and the config agree.
      jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      let reads = 0
      const options = { env: {} }
      Object.defineProperty(options, key, {
        enumerable: true,
        get: () => {
          reads += 1
          return value
        }
      })
      await startTelemetry(options as TelemetryOptions)
      expect(reads).toBe(1)
    })
  })

  describe('an Nth-operation sweep', () => {
    /** The most operations the options of a start are put through; the sweep ends well before it. */
    const MOST_OPERATIONS = 60

    type Behaviour = 'throw' | 'flip'

    /**
     * Wraps an object in a proxy whose `n`th operation, counted across every wrapped object of a run, throws
     * or, for a property read, answers the opposite of the truth.
     */
    function sweep(
      n: number,
      behaviour: Behaviour
    ): { wrap: <T extends object>(t: T) => T; count: () => number } {
      let seen = 0
      const hit = (): boolean => {
        seen += 1
        return seen === n
      }
      const fail = (): never => {
        throw new Error(`operation ${n} failed`)
      }
      const wrap = <T extends object>(target: T): T =>
        new Proxy(target, {
          get(t, key, receiver) {
            const value: unknown = Reflect.get(t, key, receiver)
            if (!hit()) return value
            if (behaviour === 'throw') return fail()
            return typeof value === 'boolean' ? !value : value
          },
          has(t, key) {
            if (hit() && behaviour === 'throw') fail()
            return Reflect.has(t, key)
          },
          ownKeys(t) {
            if (hit() && behaviour === 'throw') fail()
            return Reflect.ownKeys(t)
          },
          getOwnPropertyDescriptor(t, key) {
            if (hit() && behaviour === 'throw') fail()
            return Reflect.getOwnPropertyDescriptor(t, key)
          }
        })
      return { wrap, count: () => seen }
    }

    /** Every option of a start, each object and the array wrapped (the function is stored and never called by a start). */
    const optionsFor = (wrap: <T extends object>(t: T) => T): TelemetryOptions =>
      wrap({
        env: wrap({}),
        serviceName: 'sweep-service',
        serviceVersion: '1.2.3',
        extraRedactedQueryParams: wrap(['sid', 'token']),
        ignoreIncomingRequest: () => false,
        shutdownTimeoutMs: 1000,
        unsafe: wrap({ exportHostId: true as const, disableUrlRedaction: true as const }),
        instrumentations: wrap({ sendLogs: false, overrides: wrap({}) })
      }) as unknown as TelemetryOptions

    it('ends a run whose nth operation throws in that error, with no half-started SDK', async () => {
      // Scenario: the host passes options whose operations can fail (a getter that throws, a proxy). For
      // every position of the failure the start rejects with the host's own error, leaves no handle and
      // starts no SDK, so a later start is not blocked; the sweep ends when a position is never reached.
      jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      let swept = 0
      for (let n = 1; n <= MOST_OPERATIONS; n += 1) {
        mockSdkInstance.start.mockClear()
        const run = sweep(n, 'throw')
        const outcome = await startTelemetry(optionsFor(run.wrap)).then(
          () => 'started',
          (error: unknown) => (error as Error).message
        )
        if (outcome === 'started') {
          expect(run.count()).toBeLessThan(n)
          break
        }
        swept += 1
        expect(outcome).toBe(`operation ${n} failed`)
        expect(currentHandle()).toBeUndefined()
        expect(mockSdkInstance.start).not.toHaveBeenCalled()
        // Nothing is cleared by hand before this: a start after the failed one must not be blocked.
        const later = await startTelemetry({ env: {} })
        expect(later.enabled).toBe(true)
        clearHandle()
        clearPendingStart()
      }
      expect(swept).toBeGreaterThan(20)
      expect(swept).toBeLessThan(MOST_OPERATIONS)
    })

    it('warns about exactly the redactions it applies when the nth read answers the opposite', async () => {
      // Scenario: the same proxies, but the nth property read answers the opposite instead of throwing.
      // Whatever the position, the host-id and URL warnings are emitted exactly when the SDK exports the
      // host id and leaves the URL redactor out.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const warned = (pattern: RegExp): boolean =>
        emitWarning.mock.calls.some(([text]) => pattern.test(String(text)))
      let swept = 0
      for (let n = 1; n <= MOST_OPERATIONS; n += 1) {
        mockNodeSdk.mockClear()
        emitWarning.mockClear()
        const run = sweep(n, 'flip')
        await startTelemetry(optionsFor(run.wrap))
        const [sdkOptions] = mockNodeSdk.mock.calls[0] as unknown as [
          {
            resourceDetectors: { detect: () => { attributes: Record<string, unknown> } }[]
            spanProcessors: unknown[]
          }
        ]
        const exportsHostId =
          'host.id' in (sdkOptions.resourceDetectors[2]?.detect().attributes ?? {})
        const redactorLeftOut = sdkOptions.spanProcessors.length === 1
        expect(warned(/Host id redaction is disabled/)).toBe(exportsHostId)
        expect(warned(/URL redaction is disabled/)).toBe(redactorLeftOut)
        swept += 1
        clearHandle()
        clearPendingStart()
        if (run.count() < n) break
      }
      expect(swept).toBeGreaterThan(5)
      expect(swept).toBeLessThan(MOST_OPERATIONS)
    })
  })
})
