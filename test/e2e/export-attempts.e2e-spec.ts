/**
 * @fileoverview Pins, in a real Node process, that a name planted after the check of an export is still seen by the
 * request: while the transport loads what it needs for its first send, and while it waits to retry a 503. Neither
 * may reach the collector, and without a plant both do.
 * @layer e2e
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

import { guardExports } from '../../src/sdk/export-guard'

import { startCollector } from './fixtures/collector'
import type { Collector } from './fixtures/collector'
import { bundleSdk, runInRealProcess } from './fixtures/real-process'
import type { SdkBundle } from './fixtures/real-process'

let bundle: SdkBundle
let collector: Collector

beforeAll(() => {
  bundle = bundleSdk('test/e2e/fixtures/guard-entry.ts')
}, 120_000)

afterAll(() => {
  bundle.remove()
})

afterEach(async () => {
  await collector.close()
})

/**
 * The child: a guarded OTLP exporter, one span exported by hand, and a plant at the chosen moment.
 * `PLANT_AT` is `now` (right after the export call, before the first send has loaded anything), a number of
 * milliseconds (during the back-off of a retry) or empty (never).
 */
const CHILD = `
const { guardExports } = require(process.env.BUNDLE)
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http')
const { TracerProvider } = require('@opentelemetry/sdk-trace')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
;(async () => {
  if (process.env.WRAP_PROMISE === '1') {
    // What a tracing agent or a context manager does after the library loaded: wraps the global Promise and its then.
    const then = Promise.prototype.then
    Promise.prototype.then = function (...args) { return then.apply(this, args) }
    const Original = Promise
    globalThis.Promise = class extends Original {}
  }
  const slow = Number(process.env.SLOW_HEADERS || 0)
  let unhandled = 0
  process.on('unhandledRejection', () => { unhandled += 1 })
  const headers = slow ? async () => { await sleep(slow); return { 'x-host': 'yes' } } : undefined
  const exporter = new OTLPTraceExporter({
    url: process.env.ENDPOINT + '/v1/traces',
    ...(headers ? { headers } : {})
  })
  if (process.env.SEND_THROWS === '1') {
    exporter._delegate._transport._transport.send = () => { throw new Error('send threw') }
  }
  guardExports(exporter)
  const ended = []
  const collect = { onStart() {}, onEnd: (span) => ended.push(span), forceFlush: () => Promise.resolve(), shutdown: () => Promise.resolve() }
  const provider = new TracerProvider({ spanProcessors: [collect] })
  provider.getTracer('child').startSpan('attempt').end()
  const results = []
  const errors = []
  exporter.export(ended, (result) => { results.push(result.code); errors.push(result.error ? result.error.message : null) })
  if (process.env.PLANT_AT === 'now') Object.prototype.planted = 'x'
  else if (process.env.PLANT_AT) setTimeout(() => { Object.prototype.planted = 'x' }, Number(process.env.PLANT_AT))
  await sleep(Number(process.env.WAIT))
  await sleep(100)
  console.log(JSON.stringify({ results, errors, unhandled }))
})()
`

/** Runs the child against the collector. */
async function run(
  plantAt: string,
  wait: number,
  wrapPromise = false,
  slowHeaders = 0,
  sendThrows = false
): Promise<{ results: number[]; errors: (string | null)[]; unhandled: number }> {
  const result = await runInRealProcess(
    CHILD,
    {
      BUNDLE: bundle.file,
      ENDPOINT: collector.endpoint,
      PLANT_AT: plantAt,
      WAIT: String(wait),
      WRAP_PROMISE: wrapPromise ? '1' : '0',
      SLOW_HEADERS: String(slowHeaders),
      SEND_THROWS: sendThrows ? '1' : '0'
    },
    30_000
  )
  return JSON.parse(result.lines[result.lines.length - 1] ?? '{}') as {
    results: number[]
    errors: (string | null)[]
    unhandled: number
  }
}

describe('a name planted after the check of an export, in a real process', () => {
  it('sends the first attempt on a clean prototype, and nothing when a name is planted while it loads', async () => {
    // Scenario: the check at the export passes, the plant comes right after it, and the transport then awaits the
    // modules it loads before it reads its headers: the read refuses, so the collector gets no request and the
    // export is reported as failed.
    collector = await startCollector()
    const clean = await run('', 1500)
    expect(collector.bodies).toHaveLength(1)
    expect(clean.results).toEqual([0])
    await collector.close()
    collector = await startCollector()
    const planted = await run('now', 1500)
    expect(collector.bodies).toHaveLength(0)
    expect(planted.results).toEqual([1])
  }, 60_000)

  it('sends normally when the global Promise and its then were wrapped after the library loaded', async () => {
    // Scenario: tracing agents and context managers wrap Promise after load; the guard looks at Object.prototype
    // only, so that is not a pollution: the batch is sent and the export succeeds.
    collector = await startCollector()
    const answer = await run('', 1500, true)
    expect(collector.bodies).toHaveLength(1)
    expect(answer.results).toEqual([0])
  }, 60_000)

  it('refuses the request, with the refusal and not an error of the http module, when a name is planted while a headers provider of the host waits', async () => {
    // Scenario: a host-supplied asynchronous headers provider takes 300 ms, a name is planted at 100 ms, and the
    // request that its answer would have started is refused: no request reaches the collector and the error is the
    // refusal, not a failure inside the http module; the same provider with nothing planted sends.
    collector = await startCollector()
    const clean = await run('', 1500, false, 300)
    expect(collector.bodies).toHaveLength(1)
    expect(clean.results).toEqual([0])
    await collector.close()
    collector = await startCollector()
    const planted = await run('100', 1500, false, 300)
    expect(collector.bodies).toHaveLength(0)
    expect(planted.results).toEqual([1])
    expect(planted.errors).toEqual([
      'Object.prototype or a built-in of this process was changed, so the batch was dropped.'
    ])
  }, 60_000)

  it('drops the batch without an unhandled rejection when a provider plants a name and returns a promise that rejects', async () => {
    // Scenario: a provider that the transport calls directly plants a name while it runs and returns a promise
    // that rejects; the guard refuses the answer, and the promise it drops is given a handler, so the process
    // sees no unhandled rejection and lives to report. The refusal is still the error the caller gets.
    collector = await startCollector()
    const child = `
const { guardExports } = require(process.env.BUNDLE)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
;(async () => {
  let unhandled = 0
  process.on('unhandledRejection', () => { unhandled += 1 })
  class Base { _delegate = { _transport: { send: () => undefined, _parameters: { headers: () => { Object.prototype.planted = 'x'; return Promise.reject(new Error('headers failed')) } } } }
    export(items, done) { done({ code: 0 }) } }
  class Sub extends Base {}
  const exporter = new Sub()
  guardExports(exporter)
  exporter.export([], () => undefined)
  let refusal = null
  try { exporter._delegate._transport._parameters.headers() } catch (error) { refusal = error.message }
  await sleep(300)
  console.log(JSON.stringify({ refusal, unhandled }))
})()
`
    const result = await runInRealProcess(child, { BUNDLE: bundle.file }, 30_000)
    expect(JSON.parse(result.lines[result.lines.length - 1] ?? '{}')).toEqual({
      refusal:
        'Object.prototype or a built-in of this process was changed, so the batch was dropped.',
      unhandled: 0
    })
    expect(result.code).toBe(0)
  }, 60_000)

  it('retries a 503 on a clean prototype, and sends no retry when a name is planted during the back-off', async () => {
    // Scenario: the first attempt is answered 503 and the transport waits about a second before it tries again;
    // with nothing planted the second request arrives, with a name planted during the wait it never does.
    collector = await startCollector(1)
    await run('', 3500)
    expect(collector.bodies).toHaveLength(2)
    await collector.close()
    collector = await startCollector(1)
    const planted = await run('400', 3500)
    expect(collector.bodies).toHaveLength(1)
    expect(planted.results).toEqual([1])
  }, 60_000)

  it('refuses the attempt and the read of the headers of a real exporter, in this process, while a name is planted', async () => {
    // Scenario: an exporter of the library's peer, wrapped and exported through once, has a transport whose
    // send answers a failure with no request, and whose headers provider throws, for as long as a name is planted;
    // an exporter of another shape is exported through without a throw.
    collector = await startCollector()
    const exporter = new OTLPTraceExporter({ url: `${collector.endpoint}/v1/traces` })
    guardExports(exporter)
    exporter.export([], () => undefined)
    const transport = (
      exporter as unknown as {
        _delegate: {
          _transport: {
            _transport: {
              send(data: Uint8Array, timeout: number): Promise<{ status: string }>
              _parameters: { headers(): unknown }
            }
          }
        }
      }
    )._delegate._transport._transport
    Object.defineProperty(Object.prototype, 'plantedForTheAttempt', {
      value: 'x',
      enumerable: true,
      configurable: true,
      writable: true
    })
    try {
      await expect(transport.send(new Uint8Array(1), 1000)).resolves.toMatchObject({
        status: 'failure'
      })
      expect(() => transport._parameters.headers()).toThrow('so the batch was dropped')
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['plantedForTheAttempt']
    }
    expect(collector.bodies).toHaveLength(0)
    class Plain {
      export(_items: unknown, done: (result: { code: number }) => void): void {
        done({ code: 0 })
      }
    }
    class Other extends Plain {}
    const other = new Other()
    guardExports(other)
    expect(() => other.export([], () => undefined)).not.toThrow()
  })

  it('refuses the answer of an asynchronous headers provider of a real exporter when a name is planted before it resolves', async () => {
    // Scenario: the provider is called, a name is planted while its promise is pending, and the answer is refused;
    // the same provider on a clean prototype resolves to its headers.
    collector = await startCollector()
    const exporter = new OTLPTraceExporter({
      url: `${collector.endpoint}/v1/traces`,
      headers: () => Promise.resolve({ 'x-host': 'yes' })
    })
    guardExports(exporter)
    exporter.export([], () => undefined)
    const parameters = (
      exporter as unknown as {
        _delegate: {
          _transport: {
            _transport: { _parameters: { headers(): Promise<Record<string, string>> } }
          }
        }
      }
    )._delegate._transport._transport._parameters
    await expect(parameters.headers()).resolves.toMatchObject({ 'x-host': 'yes' })
    const pending = parameters.headers()
    Object.defineProperty(Object.prototype, 'plantedWhileWaiting', {
      value: 'x',
      enumerable: true,
      configurable: true,
      writable: true
    })
    try {
      await expect(pending).rejects.toThrow('so the batch was dropped')
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['plantedWhileWaiting']
    }
  })
})

/** Plants a name on the root prototype, as a pollution does. */
function plant(): void {
  Object.defineProperty(Object.prototype, 'plantedByTheProvider', {
    value: 'x',
    enumerable: true,
    configurable: true,
    writable: true
  })
}

/** Removes the name `plant` put there. */
function unplant(): void {
  delete (Object.prototype as unknown as Record<string, unknown>)['plantedByTheProvider']
}

/** An exporter whose transport holds one metadata provider, as a gRPC one does, armed by an export; returns it as wrapped. */
function wrapped(provider: () => unknown): () => unknown {
  class Plain {
    _delegate = { _transport: { send: () => undefined, _parameters: { metadata: provider } } }
    export(_items: unknown, done: (result: { code: number }) => void): void {
      done({ code: 0 })
    }
  }
  class Other extends Plain {}
  const other = new Other()
  guardExports(other)
  other.export([], () => undefined)
  return other._delegate._transport._parameters.metadata as () => unknown
}

describe('the providers of a transport that answer synchronously, in this process', () => {
  it('hands the answer back as it is: null, a text and an object with no then', () => {
    // Scenario: a transport whose providers are synchronous (a gRPC one reads its metadata that way) keeps them
    // synchronous: nothing is waited for and nothing is changed.
    const plain = { then: 'no' }
    expect(wrapped(() => plain)()).toBe(plain)
    expect(wrapped(() => null)()).toBeNull()
    expect(wrapped(() => 'text')()).toBe('text')
  })

  it('refuses an answer given after the provider planted a name, and takes the rejection of a promise it drops', async () => {
    // Scenario: a provider that plants a name while it runs is refused; when it returns a promise that rejects, the
    // promise is given a handler, so the refusal is not followed by an unhandled rejection.
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const planting = wrapped(() => {
        plant()
        return 'answer'
      })
      expect(() => planting()).toThrow('so the batch was dropped')
      unplant()
      const rejecting = wrapped(() => {
        plant()
        return Promise.reject(new Error('provider failed'))
      })
      expect(() => rejecting()).toThrow('so the batch was dropped')
    } finally {
      process.off('unhandledRejection', unhandled)
      unplant()
    }
    await new Promise((resolve) => setImmediate(resolve))
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('reports the export as failed, with the reason, when the transport throws before it returns a promise', async () => {
    // Scenario: a send that throws synchronously is a failed attempt: no request reaches the collector and the
    // callback of the export is told, with the reason of the throw.
    collector = await startCollector()
    const thrown = await run('', 1500, false, 0, true)
    expect(collector.bodies).toHaveLength(0)
    expect(thrown.results).toEqual([1])
    expect(thrown.errors).toEqual(['send threw'])
  }, 60_000)
})
