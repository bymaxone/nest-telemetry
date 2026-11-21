/**
 * @fileoverview Tests that `startTelemetry` reads each option the steps of a start share once, and
 * that a warning about a turned-off redaction agrees with the redaction the SDK applies, with the SDK
 * packages replaced by doubles.
 * @layer sdk
 */
import { clearHandle, clearPendingStart } from './handle'
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

    it.each([
      ['unsafe', 'disableUrlRedaction', true],
      ['unsafe', 'disableRedisArgumentRedaction', true],
      ['unsafe', 'exportProcessCommandArgs', true],
      ['unsafe', 'exportHostId', true],
      ['instrumentations', 'fs', true],
      ['instrumentations', 'sendLogs', true],
      ['instrumentations', 'overrides', {}]
    ])('reads %s.%s once in a start', async (option, field, value) => {
      // Scenario: a field of the option is a getter that answers differently on each read. Each step of
      // a start (the warning, the SDK build, the instrumentation config) used to read the field itself;
      // they now share one read, so the warning and the effect cannot disagree.
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
})
