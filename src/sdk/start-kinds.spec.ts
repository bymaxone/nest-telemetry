/**
 * @fileoverview Tests that `startTelemetry` refuses an option of the wrong kind, names it without
 * repeating its value, and leaves nothing running, with the SDK packages replaced by doubles.
 * @layer sdk
 */
import { clearHandle, clearPendingStart, currentHandle } from './handle'
import { MAX_OPTION_ENTRIES, TelemetryOptionError } from './option-kinds'
import { startTelemetry } from './start'
import type { TelemetryOptions } from './types'

const mockSdkInstance = {
  start: jest.fn<void, []>(),
  shutdown: jest.fn<Promise<void>, []>()
}
const mockNodeSdk = jest.fn((..._args: unknown[]) => mockSdkInstance)
const mockAutoInstrumentations = jest.fn((..._args: unknown[]) => ['instrumentation'])

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
  getNodeAutoInstrumentations: (...args: unknown[]) => mockAutoInstrumentations(...args)
}))
jest.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: () => ({ kind: 'resource' }),
  envDetector: {},
  hostDetector: {},
  osDetector: {},
  processDetector: {},
  serviceInstanceIdDetector: {}
}))

// A value that must never reach an error message.
const SECRET = 'hunter2-sentinel'

/** The error a start rejects with. */
async function refusal(options: unknown): Promise<unknown> {
  return startTelemetry(options as TelemetryOptions).then(
    () => undefined,
    (error: unknown) => error
  )
}

beforeEach(() => {
  mockSdkInstance.shutdown.mockResolvedValue(undefined)
  jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
})

afterEach(() => {
  clearHandle()
  clearPendingStart()
})

const NOT_BOOLEANS: [string, unknown][] = [
  ['the string false', 'false'],
  ['the string true', 'true'],
  ['a number', 1],
  ['an object', {}],
  ['a secret string', SECRET]
]

const BOOLEAN_OPTIONS: [string, (value: unknown) => unknown][] = [
  ['enabled', (value) => ({ enabled: value })],
  ['instrumentations.sendLogs', (value) => ({ instrumentations: { sendLogs: value } })],
  ['instrumentations.fs', (value) => ({ instrumentations: { fs: value } })],
  ['unsafe.disableUrlRedaction', (value) => ({ unsafe: { disableUrlRedaction: value } })],
  [
    'unsafe.disableRedisArgumentRedaction',
    (value) => ({ unsafe: { disableRedisArgumentRedaction: value } })
  ],
  ['unsafe.exportProcessCommandArgs', (value) => ({ unsafe: { exportProcessCommandArgs: value } })],
  ['unsafe.exportHostId', (value) => ({ unsafe: { exportHostId: value } })]
]

describe('startTelemetry refuses an option of the wrong kind', () => {
  describe.each(BOOLEAN_OPTIONS)('%s', (name, build) => {
    it.each(NOT_BOOLEANS)(
      'rejects %s, names the option and starts nothing',
      async (_what, value) => {
        // Scenario: a boolean option holds something that is not a boolean. The string 'false' used to
        // turn log export on and the string 'true' on an unsafe flag used to be dropped without a word;
        // both are refused now, with the option named and the value left out.
        const error = await refusal({ env: {}, ...(build(value) as object) })
        expect(error).toBeInstanceOf(TelemetryOptionError)
        expect(error).toMatchObject({ code: 'BYMAX_TELEMETRY_OPTION_INVALID', option: name })
        expect((error as Error).message).toContain(`The ${name} option must be a boolean`)
        expect((error as Error).message).not.toContain(SECRET)
        expect(mockNodeSdk).not.toHaveBeenCalled()
        expect(currentHandle()).toBeUndefined()
      }
    )

    it.each([true, false])('starts when the option is the boolean %p', async (value) => {
      // Scenario: the control for the rows above: a boolean is accepted, so the refusal is about the
      // kind and not about the option.
      const handle = await startTelemetry({
        env: {},
        ...(build(value) as object)
      } as TelemetryOptions)
      expect(handle.enabled).toBe(name === 'enabled' ? value : true)
    })
  })

  it('lets a later start succeed after a refusal', async () => {
    // Scenario: a refused call leaves no SDK, no handle and no pending start behind.
    await refusal({ env: {}, instrumentations: { sendLogs: 'false' } })
    const handle = await startTelemetry({ env: {} })
    expect(handle.enabled).toBe(true)
  })

  it.each([
    ['serviceName', { serviceName: 5 }],
    ['serviceVersion', { serviceVersion: {} }],
    ['ignoreIncomingRequest', { ignoreIncomingRequest: 'yes' }],
    ['instrumentations', { instrumentations: 'all' }],
    ['unsafe', { unsafe: true }],
    ['env', { env: 'production' }],
    ['instrumentations.overrides', { instrumentations: { overrides: [] } }],
    ['instrumentations.overrides', { instrumentations: { overrides: { http: 'on' } } }],
    ['instrumentations.overrides', { instrumentations: { overrides: { http: [] } } }]
  ])('rejects a %s of the wrong kind', async (name, options) => {
    // Scenario: an option that is a string, a function or an object holds a value of another kind.
    const error = await refusal({ env: {}, ...options })
    expect(error).toMatchObject({ code: 'BYMAX_TELEMETRY_OPTION_INVALID', option: name })
    expect(mockNodeSdk).not.toHaveBeenCalled()
  })

  it('accepts a function for ignoreIncomingRequest', async () => {
    // Scenario: the control for the row above.
    const handle = await startTelemetry({ env: {}, ignoreIncomingRequest: () => false })
    expect(handle.enabled).toBe(true)
  })
})

describe('startTelemetry refuses a list or a map of the wrong shape', () => {
  it.each([
    ['a string, which spread into its characters', 'abc'],
    ['a number', 5],
    ['an object', { length: 1, 0: 'a' }],
    ['an array with an item that is not a string', ['a', 1]],
    ['an array with an item that is undefined', ['a', undefined]],
    ['an array over the cap', Array.from({ length: MAX_OPTION_ENTRIES + 1 }, () => 'a')]
  ])('rejects extraRedactedQueryParams that is %s', async (_what, value) => {
    // Scenario: the list is a string that would spread into characters, a number that would throw a
    // TypeError out of the start, or a list of the wrong items or length.
    const error = await refusal({ env: {}, extraRedactedQueryParams: value })
    expect(error).toBeInstanceOf(TelemetryOptionError)
    expect(error).toMatchObject({ option: 'extraRedactedQueryParams' })
    expect(mockNodeSdk).not.toHaveBeenCalled()
  })

  it('accepts a list at the cap and one that is empty', async () => {
    // Scenario: the boundary of the cap, and the control for the rows above.
    const atCap = Array.from({ length: MAX_OPTION_ENTRIES }, (_, index) => `p${index}`)
    await expect(
      startTelemetry({ env: {}, extraRedactedQueryParams: atCap })
    ).resolves.toMatchObject({ enabled: true })
    clearHandle()
    clearPendingStart()
    await expect(startTelemetry({ env: {}, extraRedactedQueryParams: [] })).resolves.toMatchObject({
      enabled: true
    })
  })

  it('reads the length of the list once and each item once', async () => {
    // Scenario: a list that answers differently on each read; one read of each is what the start uses.
    const reads = { length: 0, items: 0 }
    const list = new Proxy(['a', 'b'], {
      get(target, key, receiver): unknown {
        if (key === 'length') reads.length += 1
        else if (key === '0' || key === '1') reads.items += 1
        return Reflect.get(target, key, receiver) as unknown
      }
    })
    await startTelemetry({ env: {}, extraRedactedQueryParams: list })
    expect(reads).toEqual({ length: 1, items: 2 })
  })

  it.each([-1, 1.5, '2', Number.NaN])('rejects a list whose length reads as %p', async (length) => {
    // Scenario: the length of a list that is not an integer from 0 up; only an object that stands in
    // for an array can answer that, and the start must not loop on it.
    const list = new Proxy(['a'], {
      get: (target, key, receiver): unknown =>
        key === 'length' ? length : (Reflect.get(target, key, receiver) as unknown)
    })
    const error = await refusal({ env: {}, extraRedactedQueryParams: list })
    expect(error).toMatchObject({ option: 'extraRedactedQueryParams' })
  })

  it('rejects overrides over the cap', async () => {
    // Scenario: a map with more entries than the cap.
    const overrides = Object.fromEntries(
      Array.from({ length: MAX_OPTION_ENTRIES + 1 }, (_, index) => [`i${index}`, {}])
    )
    const error = await refusal({ env: {}, instrumentations: { overrides } })
    expect(error).toMatchObject({ option: 'instrumentations.overrides' })
  })
})

describe('startTelemetry reads enabled and env once', () => {
  it('warns from the read the call acted on', async () => {
    // Scenario: with an SDK running, `enabled` answers false on its first read and true on every later
    // one. The call is a disabled start, and the warning must say so and not that the options of the
    // call were ignored.
    await startTelemetry({ env: {} })
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    emitWarning.mockClear()
    let reads = 0
    await startTelemetry({
      get enabled() {
        reads += 1
        return reads === 1 ? false : true
      }
    })
    expect(reads).toBe(1)
    expect(emitWarning).toHaveBeenCalledTimes(1)
    expect(String(emitWarning.mock.calls[0]?.[0])).toContain('does not stop the running SDK')
  })

  it('reads env once', async () => {
    // Scenario: `env` is a getter; the reader of the environment and the warning share one read.
    let reads = 0
    await startTelemetry({
      get env() {
        reads += 1
        return {}
      }
    })
    expect(reads).toBe(1)
  })
})

describe('startTelemetry keeps the documented fallback for shutdownTimeoutMs', () => {
  it.each(['soon', -1, Number.NaN, 500000])('starts for %p and uses the default', async (value) => {
    // Scenario: a value that is not a finite number in range means the default; it is not refused.
    const handle = await startTelemetry({ env: {}, shutdownTimeoutMs: value as number })
    expect(handle.enabled).toBe(true)
  })
})
