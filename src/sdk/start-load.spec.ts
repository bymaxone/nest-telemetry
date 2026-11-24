/**
 * @fileoverview Tests how `startTelemetry` takes the loaded packages: whichever static or `then` something replaced
 * after the library loaded, a package that failed to load, and a load that cannot be trusted.
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
  jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
})

afterEach(() => {
  clearHandle()
  clearPendingStart()
  jest.restoreAllMocks()
})

describe('the packages a start takes', () => {
  it('builds the SDK from the packages that were loaded, not from what a replaced Promise.all returns', async () => {
    // Scenario: Promise.all was replaced after the library loaded and answers with packages of its own; the
    // start never calls it, so the SDK it builds is the loaded one and the forged constructor is never run.
    const forged = jest.fn()
    const original = Promise.all
    Promise.all = (() =>
      Promise.resolve([{ NodeSDK: forged }, {}, {}, {}, {}])) as unknown as typeof Promise.all
    try {
      const handle = await startTelemetry({ env: {} })
      expect(handle.enabled).toBe(true)
      expect(forged).not.toHaveBeenCalled()
      expect(mockNodeSdk).toHaveBeenCalledTimes(1)
    } finally {
      Promise.all = original
    }
  })

  it('rejects with the reason of the first package that failed to load, and ignores the later ones', async () => {
    // Scenario: a missing peer rejects its import; the start rejects once with that reason, and a second
    // rejection is taken without an unhandled rejection or a second settlement.
    jest.resetModules()
    jest.doMock('@opentelemetry/sdk-trace', () => {
      throw new Error('first missing')
    })
    jest.doMock('@opentelemetry/resources', () => {
      throw new Error('second missing')
    })
    const { startTelemetry: fresh } = await import('./start')
    await expect(fresh({ env: {} })).rejects.toThrow(/first missing|second missing/)
    jest.dontMock('@opentelemetry/sdk-trace')
    jest.dontMock('@opentelemetry/resources')
  })

  it('starts nothing when an import did not answer with a promise of the engine', async () => {
    // Scenario: the import of a package answered with an object that is not a promise (the static it is built on
    // was replaced); there is nothing to trust a value from, so the handle is the disabled one and no SDK is built.
    const original = Promise.resolve
    Promise.resolve = (() => ({ then: () => ({}) })) as unknown as typeof Promise.resolve
    try {
      const handle = await startTelemetry({ env: {} })
      expect(handle.enabled).toBe(false)
      expect(mockNodeSdk).not.toHaveBeenCalled()
    } finally {
      Promise.resolve = original
    }
  })

  it('starts nothing when the prototype was polluted while the packages loaded', async () => {
    // Scenario: a name planted after the call began and before the packages arrived is seen by the check that
    // comes last before they are handed over, and the start is refused.
    const pending = startTelemetry({ env: {} })
    Object.defineProperty(Object.prototype, 'plantedWhileLoading', {
      value: 1,
      enumerable: true,
      configurable: true,
      writable: true
    })
    try {
      const handle = await pending
      expect(handle.enabled).toBe(false)
      expect(mockNodeSdk).not.toHaveBeenCalled()
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['plantedWhileLoading']
    }
  })

  it('stops the SDK it started when the process turned polluted while it started', async () => {
    // Scenario: a name is planted by the start of the SDK itself; the answer is the disabled handle, so nothing else
    // could stop the SDK that just started and registered, and the start stops it.
    mockSdkInstance.start.mockImplementationOnce(() => {
      Object.defineProperty(Object.prototype, 'plantedWhileStarting', {
        value: 1,
        enumerable: true,
        configurable: true,
        writable: true
      })
    })
    try {
      const handle = await startTelemetry({ env: {} })
      expect(handle.enabled).toBe(false)
      await new Promise((resolve) => setImmediate(resolve))
      expect(mockSdkInstance.shutdown).toHaveBeenCalledTimes(1)
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['plantedWhileStarting']
    }
  })
})
