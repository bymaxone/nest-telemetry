/**
 * @fileoverview Pins, in a real Node process, that a name only the root prototype of the process
 * holds decides nothing about the export: where it goes, what it carries, whether it is sampled,
 * whether the SDK runs, which service it names, which request headers and hooks the HTTP
 * instrumentation uses. The planted names stay on the root prototype after the start too.
 * @layer e2e
 */
import { startCollector } from './fixtures/collector'
import type { Collector } from './fixtures/collector'
import { bundleSdk, runInRealProcess } from './fixtures/real-process'
import type { SdkBundle } from './fixtures/real-process'

let collector: Collector
let bundle: SdkBundle

beforeAll(() => {
  bundle = bundleSdk()
}, 120_000)

afterAll(() => {
  bundle.remove()
})

beforeEach(async () => {
  collector = await startCollector()
})

afterEach(async () => {
  await collector.close()
})

/**
 * The child script: plants names on the root prototype, starts telemetry, records a span, plants names again,
 * records another, optionally builds an exporter of its own, and prints what happened as JSON lines.
 */
const CHILD = `
const plant = (names) => {
  for (const [name, value] of Object.entries(names)) {
    Object.defineProperty(Object.prototype, name, { value, enumerable: true, configurable: true, writable: true })
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
process.on('warning', (warning) => {
  if (warning.code === 'BYMAX_TELEMETRY_REALM_POLLUTED') console.log(JSON.stringify({ warning: warning.message, detail: warning.detail }))
})
// Hidden before the library loads: not enumerable, so the bundle's export helper still loads.
for (const [name, value] of Object.entries(JSON.parse(process.env.PLANT_HIDDEN || '{}'))) {
  Object.defineProperty(Object.prototype, name, { value, enumerable: false, configurable: true, writable: true })
}
const { startTelemetry } = require(process.env.BUNDLE)
const { trace } = require('@opentelemetry/api')
for (const [name, value] of Object.entries(JSON.parse(process.env.PLANT_READONLY || '{}'))) {
  Object.defineProperty(Object.prototype, name, { value, enumerable: false, configurable: true, writable: false })
}
// Planted after the library is loaded: a bundle's own export helper walks its exports with for-in, so an
// enumerable name planted before the load stops it from loading at all.
plant(JSON.parse(process.env.PLANT || '{}'))
;(async () => {
  const pending = startTelemetry({ serviceName: 'host-api', env: { OTEL_BSP_SCHEDULE_DELAY: '200' } })
  // Planted while the packages load, and removed again as soon as the start has answered.
  const during = JSON.parse(process.env.PLANT_DURING || '{}')
  plant(during)
  const handle = await pending
  for (const name of Object.keys(during)) delete Object.prototype[name]
  console.log(JSON.stringify({ enabled: handle.enabled }))
  trace.getTracer('child').startSpan('before').end()
  await sleep(900)
  plant(JSON.parse(process.env.PLANT_AFTER || '{}'))
  trace.getTracer('child').startSpan('after').end()
  await sleep(900)
  if (process.env.HOST_EXPORTER === '1') {
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http')
    const { TracerProvider, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace')
    const exporter = new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT + '/v1/traces' })
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] })
    provider.getTracer('host').startSpan('host-span').end()
    await sleep(900)
  }
  await handle.shutdown()
  console.log(JSON.stringify({ done: true }))
})()
`

/** What the child printed, merged into one object, and how it ended. */
async function runChild(environment: Record<string, string>): Promise<{
  enabled?: boolean
  warning?: string
  detail?: string
  done?: boolean
  code: number | null
}> {
  const result = await runInRealProcess(
    CHILD,
    { BUNDLE: bundle.file, OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint, ...environment },
    30_000
  )
  const answers = result.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  return Object.assign({ code: result.code }, ...answers) as {
    enabled?: boolean
    warning?: string
    detail?: string
    done?: boolean
    code: number | null
  }
}

describe('a name that only the root prototype of the process holds, in a real process', () => {
  it('starts nothing and exports nothing when names are planted before the start, and says how many', async () => {
    // Scenario: a polluted process, whatever the names are (an endpoint, a proxy, a sampler, a service name, a
    // hook), starts no SDK: the handle is the disabled one, the one warning carries a count and none of the
    // names, nothing reaches the collector and the host process ends normally.
    const answer = await runChild({
      PLANT: JSON.stringify({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:1/v1/traces',
        http_proxy: 'http://127.0.0.1:1',
        OTEL_TRACES_SAMPLER: 'always_off',
        serviceName: 'planted-name',
        requestHook: 'planted',
        detail: 'SECRET-DETAIL'
      })
    })
    expect(answer.enabled).toBe(false)
    expect(answer.warning).toContain('holds 6 name(s)')
    // The warning object reads a planted detail through the prototype unless it has an own one.
    expect(answer.detail).toBe('')
    expect(answer.warning).not.toMatch(/http_proxy|serviceName|requestHook|OTEL_/)
    expect(answer.done).toBe(true)
    expect(answer.code).toBe(0)
    expect(collector.bodies).toHaveLength(0)
  }, 60_000)

  it('starts nothing when a name is planted while the packages load and removed before the first export', async () => {
    // Scenario: a plant that is gone before anything is exported would otherwise be baked into the exporters the
    // SDK builds, a metrics or logs endpoint for one; the check right before the build sees it and starts nothing.
    const answer = await runChild({
      PLANT_DURING: JSON.stringify({
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://127.0.0.1:1',
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:1'
      })
    })
    expect(answer.enabled).toBe(false)
    expect(answer.warning).toContain('holds 2 name(s)')
    expect(collector.bodies).toHaveLength(0)
    expect(answer.code).toBe(0)
  }, 60_000)

  it('counts, and does not throw, when the names planted are ones the vm module reads from its options', async () => {
    // Scenario: the first count builds a fresh realm through the vm module, which reads microtaskMode,
    // contextCodeGeneration and others from the options it is given; the options have no prototype, so a
    // planted name is counted and the start answers with the disabled handle instead of rejecting.
    const answer = await runChild({
      PLANT: JSON.stringify({ microtaskMode: 'planted', contextCodeGeneration: 'planted' })
    })
    expect(answer.enabled).toBe(false)
    expect(answer.warning).toContain('holds 2 name(s)')
    expect(answer.warning).not.toContain('planted')
    expect(answer.done).toBe(true)
    expect(answer.code).toBe(0)
  }, 60_000)

  it.each(['detail', 'code', 'type'])(
    'answers with the disabled handle, and does not reject, when a read-only %s makes the warning throw',
    async (name) => {
      // Scenario: Node assigns the detail, code and type of a warning onto a plain Error, which throws for a
      // read-only name on the root prototype; the refusal still answers with the disabled handle and the
      // process ends normally.
      const answer = await runChild({ PLANT_READONLY: JSON.stringify({ [name]: 'x' }) })
      expect(answer.enabled).toBe(false)
      expect(answer.done).toBe(true)
      expect(answer.code).toBe(0)
      expect(collector.bodies).toHaveLength(0)
    },
    60_000
  )

  it('counts one, and does not throw, when a name that breaks the fresh realm is there before the library loads', async () => {
    // Scenario: with microtaskMode already on the prototype when the library loads, the fresh realm cannot be
    // built, at load or at the first count: a realm that cannot be compared counts as polluted, and the start
    // answers with the disabled handle and a count, never rejecting and never repeating the value.
    const answer = await runChild({ PLANT_HIDDEN: JSON.stringify({ microtaskMode: 'planted' }) })
    expect(answer.enabled).toBe(false)
    expect(answer.warning).toContain('holds 1 name(s)')
    expect(answer.warning).not.toContain('planted')
    expect(answer.done).toBe(true)
    expect(answer.code).toBe(0)
  }, 60_000)

  it('exports before a name is planted and drops what is exported after, and the host goes on', async () => {
    // Scenario: pollution that arrives after the start (a request planting a key) reaches the export: the batch
    // recorded after it is dropped with no I/O, the one recorded before it arrived, and the process does not crash.
    const answer = await runChild({
      PLANT_AFTER: JSON.stringify({
        OTEL_EXPORTER_OTLP_HEADERS: 'x-planted=yes',
        https_proxy: 'http://127.0.0.1:1'
      })
    })
    expect(answer.enabled).toBe(true)
    const joined = collector.bodies.join('')
    expect(joined).toContain('"before"')
    expect(joined).not.toContain('"after"')
    for (const headers of collector.headers) expect(headers['x-planted']).toBeUndefined()
    expect(answer.done).toBe(true)
    expect(answer.code).toBe(0)
  }, 60_000)

  it('exports every span on a clean prototype, and leaves an exporter the host built for itself working', async () => {
    // Scenario: the guard wraps the export of the exporter classes this library meets, which is process-wide; on a
    // clean prototype a span recorded by the SDK and one sent by an exporter the host built separately both arrive.
    const answer = await runChild({ HOST_EXPORTER: '1' })
    expect(answer.enabled).toBe(true)
    const joined = collector.bodies.join('')
    expect(joined).toContain('"before"')
    expect(joined).toContain('"after"')
    expect(joined).toContain('"host-span"')
    expect(answer.code).toBe(0)
  }, 60_000)
})
