/**
 * @fileoverview Tests the constants a module fixes when it loads, each read from a copy of the module that the test
 * itself loads: the registry keys, the export-guard marks and message, the redaction names and the restart refusal.
 * @layer sdk
 */
import type { Attributes } from '@opentelemetry/api'

jest.mock('@opentelemetry/sdk-node', () => ({ NodeSDK: function () {} }))
jest.mock('@opentelemetry/sdk-trace', () => ({ BatchSpanProcessor: function () {} }))
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: function () {} }))
jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: () => []
}))
jest.mock('@opentelemetry/resources', () => ({}))

const HANDLE_KEY = Symbol.for('@bymax-one/nest-telemetry/handle')
const PENDING_KEY = Symbol.for('@bymax-one/nest-telemetry/pending-start')
const STOPPED_KEY = Symbol.for('@bymax-one/nest-telemetry/stopped')
const MARK_KEY = Symbol.for('@bymax-one/nest-telemetry/export-guard')
const ARMED_KEY = Symbol.for('@bymax-one/nest-telemetry/export-guard/transport')

/** The registry slots of this library, cleared so one test never leaves a handle for the next. */
function clearRegistry(): void {
  Reflect.deleteProperty(globalThis, HANDLE_KEY)
  Reflect.deleteProperty(globalThis, PENDING_KEY)
  Reflect.deleteProperty(globalThis, STOPPED_KEY)
}

beforeEach(() => {
  jest.resetModules()
  clearRegistry()
})

afterEach(() => {
  jest.dontMock('./prototype-guard')
  clearRegistry()
})

describe('the registry keys of the handle module', () => {
  it('publishes the handle under its registry symbol', async () => {
    // Scenario: two copies of the library meet through globalThis, so the handle must sit under exactly this symbol.
    const { createHandle, registerHandle } = await import('./handle')
    const handle = createHandle(() => Promise.resolve())
    registerHandle(handle)
    expect(Reflect.get(globalThis, HANDLE_KEY)).toBe(handle)
  })

  it('publishes the start in progress under its registry symbol', async () => {
    // Scenario: a copy that loads later joins the start in progress through this symbol alone.
    const { setPendingStart } = await import('./handle')
    const pending = Promise.resolve({ enabled: false } as never)
    setPendingStart(pending)
    expect(Reflect.get(globalThis, PENDING_KEY)).toBe(pending)
  })

  it('publishes that an SDK was shut down under its registry symbol', async () => {
    // Scenario: a shutdown that finished is visible to every copy through this symbol alone.
    const { createHandle } = await import('./handle')
    const handle = createHandle(() => Promise.resolve())
    await handle.shutdown()
    expect(Reflect.get(globalThis, STOPPED_KEY)).toBe(true)
  })
})

/** An exporter whose base class and innermost transport have the shape the guard follows. */
function shapedExporter(): { exporter: object; base: object; transport: object } {
  class Inner {
    send = (): unknown => ({})
  }
  class Delegate {
    _transport = new Inner()
  }
  class Base {
    _delegate = new Delegate()
    export(_items: unknown, done: (result: { code: number; error?: unknown }) => void): void {
      done({ code: 0 })
    }
  }
  class Sub extends Base {}
  const exporter = new Sub()
  return { exporter, base: Base.prototype, transport: exporter._delegate._transport }
}

describe('the constants of the export guard', () => {
  it('marks the wrapped base class and the armed transport under their registry symbols', async () => {
    // Scenario: a second copy of the library finds the first one's work through these two symbols alone.
    jest.doMock('./prototype-guard', () => ({ pollutedNames: () => 0 }))
    const { guardExports } = await import('./export-guard')
    const { exporter, base, transport } = shapedExporter()
    guardExports(exporter)
    expect(Object.getOwnPropertyDescriptor(base, MARK_KEY)?.value).toBe(true)
    ;(exporter as { export(items: unknown, done: () => void): void }).export([], () => undefined)
    expect(Object.getOwnPropertyDescriptor(transport, ARMED_KEY)?.value).toBe(true)
  })

  it('drops a batch with the message that names the change', async () => {
    // Scenario: the batch is dropped while the process is polluted, and the failure says why in these exact words.
    jest.doMock('./prototype-guard', () => ({ pollutedNames: () => 1 }))
    const { guardExports } = await import('./export-guard')
    const { exporter } = shapedExporter()
    guardExports(exporter)
    const done = jest.fn()
    ;(exporter as { export(items: unknown, done: (r: unknown) => void): void }).export([], done)
    const error = (done.mock.calls[0]?.[0] as { error: Error }).error
    expect(error.message).toBe(
      'Object.prototype or a built-in of this process was changed, so the batch was dropped.'
    )
  })
})

describe('the constants of the redaction module', () => {
  it('names the parameters it redacts, the marker and the attribute that holds the query', async () => {
    // Scenario: the list, the marker and the attribute name are read from a copy loaded by this test, so a changed
    // name or an emptied list is seen.
    const redaction = await import('./redaction')
    expect(redaction.DEFAULT_REDACTED_QUERY_PARAMS).toEqual([
      'sig',
      'Signature',
      'AWSAccessKeyId',
      'X-Goog-Signature',
      'X-Amz-Signature',
      'X-Amz-Credential',
      'X-Amz-Security-Token',
      'token',
      'code',
      'access_token',
      'refresh_token',
      'id_token',
      'secret',
      'password',
      'api_key',
      'apikey',
      'key',
      'signature',
      'sas',
      'auth'
    ])
    expect(redaction.REDACTED_QUERY_VALUE).toBe('[redacted]')
    const attributes: Attributes = { 'url.query': 'token=abc' }
    const writes: [string, unknown][] = []
    redaction.redactSpanUrlQuery({
      attributes,
      setAttribute: (key: string, value: unknown): void => {
        writes.push([key, value])
      }
    } as never)
    expect(writes).toEqual([['url.query', '[redacted]']])
  })
})

describe('the restart refusal of the start module', () => {
  it('refuses a start after a shutdown with the message that says what to do instead', async () => {
    // Scenario: an SDK was shut down in this process; the second start fails with these exact words.
    Reflect.set(globalThis, STOPPED_KEY, true)
    jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const { startTelemetry } = await import('./start')
    await expect(startTelemetry({ env: {} })).rejects.toMatchObject({
      message:
        'Telemetry cannot start again after it was shut down in the same process: the modules the first start instrumented stay patched against its tracer provider, so a second SDK would export nothing for them. Start telemetry once per process; in a test suite, start it once in a global setup.'
    })
    jest.restoreAllMocks()
  })
})
