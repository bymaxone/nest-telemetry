/**
 * @fileoverview Tests that `startTelemetry` starts nothing, and says how many names, while the root prototype is
 * polluted, at the start and again right before the SDK is built, with the SDK packages replaced by doubles.
 * @layer sdk
 */
import { clearHandle, clearPendingStart } from './handle'
import { startTelemetry } from './start'

const mockSdkInstance = {
  start: jest.fn<void, []>(),
  shutdown: jest.fn<Promise<void>, []>()
}
const mockNodeSdk = jest.fn((..._args: unknown[]) => mockSdkInstance)

jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: function (...args: unknown[]) {
    return mockNodeSdk(...args)
  }
}))
jest.mock('@opentelemetry/sdk-trace', () => ({ BatchSpanProcessor: function () {} }))
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: function () {
    return { export: jest.fn() }
  }
}))
jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: () => [{ getConfig: () => ({}) }]
}))
jest.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: () => ({ kind: 'resource' }),
  envDetector: {},
  hostDetector: {},
  osDetector: {},
  processDetector: {},
  serviceInstanceIdDetector: {}
}))

beforeEach(() => {
  mockNodeSdk.mockClear()
  mockSdkInstance.shutdown.mockResolvedValue(undefined)
})

afterEach(() => {
  clearHandle()
  clearPendingStart()
})

describe('startTelemetry beside a polluted Object.prototype', () => {
  it('starts nothing, and says how many names, when Object.prototype is polluted', async () => {
    // Scenario: a process whose root prototype carries a name the engine does not define is not one telemetry
    // can trust with its data: no SDK is built, the handle is the disabled one, and the one warning carries a
    // count and never the name.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    Object.defineProperty(Object.prototype, 'plantedSecretName', {
      value: 'x',
      enumerable: true,
      configurable: true,
      writable: true
    })
    try {
      const handle = await startTelemetry({ env: {} })
      expect(handle.enabled).toBe(false)
      expect(mockNodeSdk).not.toHaveBeenCalled()
      const refused = emitWarning.mock.calls.filter(
        ([, options]) =>
          (options as { code?: string } | undefined)?.code === 'BYMAX_TELEMETRY_REALM_POLLUTED'
      )
      expect(refused).toHaveLength(1)
      expect(String(refused[0]?.[0])).toContain("differs from the engine's in 1 name(s)")
      expect(String(refused[0]?.[0])).toContain('Object.prototype or a built-in')
      expect(refused[0]?.[1]).toEqual({
        type: 'SecurityWarning',
        code: 'BYMAX_TELEMETRY_REALM_POLLUTED',
        detail: '',
        ctor: undefined
      })
      // Refused before anything else runs: not even the warning about a service name that is not set.
      expect(emitWarning.mock.calls).toHaveLength(1)
      expect(String(refused[0]?.[0])).not.toContain('plantedSecretName')
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['plantedSecretName']
    }
  })

  it('hands the warning an own, empty detail and an own ctor, so a planted one is not shown', async () => {
    // Scenario: process.emitWarning reads detail and ctor from the options it is given, which would inherit a
    // planted one and show it; the options of the refusal own both, undefined, so the warning carries the count only.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    Object.defineProperty(Object.prototype, 'detail', {
      value: 'SECRET-PLANTED',
      enumerable: true,
      configurable: true,
      writable: true
    })
    try {
      await startTelemetry({ env: {} })
      const options = emitWarning.mock.calls[0]?.[1] as object
      expect(Object.hasOwn(options, 'detail')).toBe(true)
      expect(Object.hasOwn(options, 'ctor')).toBe(true)
      expect((options as { detail?: string }).detail).toBe('')
      expect((options as { code?: string }).code).toBe('BYMAX_TELEMETRY_REALM_POLLUTED')
      expect(String(emitWarning.mock.calls[0]?.[0])).not.toContain('SECRET-PLANTED')
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['detail']
    }
  })

  it('still starts nothing, and does not reject, when the warning cannot be built', async () => {
    // Scenario: process.emitWarning throws when a name on the root prototype is read-only, because Node assigns it
    // onto the warning; the refusal stands and the host gets the disabled handle, not an exception.
    jest.spyOn(process, 'emitWarning').mockImplementation(() => {
      throw new TypeError('Cannot assign to read only property')
    })
    Object.defineProperty(Object.prototype, 'plantedSecretName', {
      value: 'x',
      enumerable: true,
      configurable: true,
      writable: true
    })
    try {
      const handle = await startTelemetry({ env: {} })
      expect(handle.enabled).toBe(false)
      expect(mockNodeSdk).not.toHaveBeenCalled()
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['plantedSecretName']
    }
  })

  it('starts nothing when a name is planted while the packages load, and is removed once the start has answered', async () => {
    // Scenario: the check is made again right before the SDK is built, with no await between them, so a name
    // planted during the import is seen even when it is gone before the first export.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const pending = startTelemetry({ serviceName: 'api', env: {} })
    Object.defineProperty(Object.prototype, 'plantedDuringTheImport', {
      value: 'x',
      enumerable: true,
      configurable: true,
      writable: true
    })
    try {
      const handle = await pending
      expect(handle.enabled).toBe(false)
      expect(mockNodeSdk).not.toHaveBeenCalled()
      expect(
        emitWarning.mock.calls.filter(
          ([, options]) =>
            (options as { code?: string } | undefined)?.code === 'BYMAX_TELEMETRY_REALM_POLLUTED'
        )
      ).toHaveLength(1)
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['plantedDuringTheImport']
    }
  })
})
