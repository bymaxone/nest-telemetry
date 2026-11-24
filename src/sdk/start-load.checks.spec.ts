/**
 * @fileoverview Tests how many times a start checks the process while the packages load: once when they arrive and
 * once more inside the continuation, and one refusal however many imports were not promises.
 * @layer sdk
 */
let mockPlanted = false
let mockPlantOnLoad = false
let mockCallsAtPlant = -1
const mockPolluted = jest.fn((): number => (mockPlanted ? 1 : 0))

jest.mock('./prototype-guard', () => ({ pollutedNames: () => mockPolluted() }))
jest.mock('@opentelemetry/sdk-node', () => ({ NodeSDK: function () {} }))
jest.mock('@opentelemetry/sdk-trace', () => ({ BatchSpanProcessor: function () {} }))
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: function () {} }))
jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: () => []
}))
jest.mock('@opentelemetry/resources', () => {
  if (mockPlantOnLoad) {
    mockCallsAtPlant = mockPolluted.mock.calls.length
    mockPlanted = true
  }
  return {}
})

beforeEach(() => {
  jest.resetModules()
  mockPlanted = false
  mockPlantOnLoad = false
  mockCallsAtPlant = -1
  mockPolluted.mockClear()
  jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
})

afterEach(async () => {
  const { clearHandle, clearPendingStart } = await import('./handle')
  clearHandle()
  clearPendingStart()
  jest.restoreAllMocks()
})

/** Starts with the first `count` imports answering with something that is not a promise, and counts the checks. */
async function checksWithNonPromises(count: number): Promise<number> {
  const { startTelemetry } = await import('./start')
  const real = Promise.resolve
  let seen = 0
  Promise.resolve = function (this: PromiseConstructor, ...args: unknown[]): unknown {
    seen += 1
    return seen <= count ? { then: () => ({}) } : Reflect.apply(real, this, args)
  } as unknown as typeof Promise.resolve
  let handle
  try {
    handle = await startTelemetry({ env: {} })
  } finally {
    Promise.resolve = real
  }
  expect(handle.enabled).toBe(false)
  return mockPolluted.mock.calls.length
}

describe('the checks of the process while the packages load', () => {
  it('checks when the last package arrives and again inside the continuation that builds', async () => {
    // Scenario: a name is planted while the packages load; the check that comes with the arrival of the last one, the
    // one inside the continuation and the one that guards the answer all run, so a name that goes away between two of
    // them is still seen by the others.
    mockPlantOnLoad = true
    const { startTelemetry } = await import('./start')
    const handle = await startTelemetry({ env: {} })
    expect(handle.enabled).toBe(false)
    expect(mockPolluted.mock.calls.length - mockCallsAtPlant).toBeGreaterThanOrEqual(3)
  })

  it('answers a refusal once, however many imports were not promises', async () => {
    // Scenario: the first import is not a promise and the load is refused at once; a second one that is not a promise
    // must not refuse again, so the process is checked the same number of times for one as for two.
    const one = await checksWithNonPromises(1)
    jest.resetModules()
    mockPolluted.mockClear()
    const two = await checksWithNonPromises(2)
    expect(two).toBe(one)
  })

  it('rejects with the reason of a package that failed to load, once', async () => {
    // Scenario: one import refuses; its reason reaches the caller, and the start is answered by it alone.
    jest.doMock('@opentelemetry/sdk-trace', () => {
      throw new Error('missing peer')
    })
    const { startTelemetry } = await import('./start')
    await expect(startTelemetry({ env: {} })).rejects.toThrow('missing peer')
    jest.dontMock('@opentelemetry/sdk-trace')
  })
})
