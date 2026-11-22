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
  const exporter = new OTLPTraceExporter({ url: process.env.ENDPOINT + '/v1/traces' })
  guardExports(exporter)
  const ended = []
  const collect = { onStart() {}, onEnd: (span) => ended.push(span), forceFlush: () => Promise.resolve(), shutdown: () => Promise.resolve() }
  const provider = new TracerProvider({ spanProcessors: [collect] })
  provider.getTracer('child').startSpan('attempt').end()
  const results = []
  exporter.export(ended, (result) => results.push(result.code))
  if (process.env.PLANT_AT === 'now') Object.prototype.planted = 'x'
  else if (process.env.PLANT_AT) setTimeout(() => { Object.prototype.planted = 'x' }, Number(process.env.PLANT_AT))
  await sleep(Number(process.env.WAIT))
  console.log(JSON.stringify({ results }))
})()
`

/** Runs the child against the collector. */
async function run(plantAt: string, wait: number): Promise<{ results: number[] }> {
  const result = await runInRealProcess(
    CHILD,
    { BUNDLE: bundle.file, ENDPOINT: collector.endpoint, PLANT_AT: plantAt, WAIT: String(wait) },
    30_000
  )
  return JSON.parse(result.lines[result.lines.length - 1] ?? '{}') as { results: number[] }
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
})
