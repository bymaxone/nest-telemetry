/**
 * @fileoverview Pins, in a real Node process, that a name only the root prototype of the process
 * holds decides nothing about the export: where it goes, what it carries, whether it is sampled,
 * whether the SDK runs, which service it names, which request headers and hooks the HTTP
 * instrumentation uses. The planted names stay on the root prototype after the start too.
 * @layer e2e
 */
import { resourceAttributes, spanAttributes, startCollector } from './fixtures/collector'
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
 * The child script: plants names on the root prototype, starts telemetry with the host's options,
 * optionally runs a real HTTP request through the instrumentation, records spans for a few seconds,
 * and prints what the start answered.
 */
const CHILD = `
const plant = JSON.parse(process.env.PLANT)
for (const [name, value] of Object.entries(plant)) {
  Object.defineProperty(Object.prototype, name, { value, configurable: true, writable: true })
}
if (process.env.PLANT_SOURCE) new Function(process.env.PLANT_SOURCE)()
const { startTelemetry } = require(process.env.BUNDLE)
const { trace } = require('@opentelemetry/api')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
;(async () => {
  const handle = await startTelemetry({ serviceName: 'host-api', env: JSON.parse(process.env.HOST_ENV || 'null') ?? undefined })
  console.log(JSON.stringify({ enabled: handle.enabled }))
  if (process.env.HTTP === '1') {
    const http = require('node:http')
    const server = http.createServer((request, response) => response.end('ok'))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    await new Promise((resolve, reject) => {
      const outgoing = http.request({ host: '127.0.0.1', port: server.address().port, path: '/x', headers: { authorization: 'Bearer HOST-SECRET-123' } }, (response) => { response.resume(); response.on('end', resolve) })
      outgoing.on('error', reject)
      outgoing.end()
    })
    await sleep(300)
    server.close()
    console.log(JSON.stringify({ hooked: globalThis.__hooked === true }))
  }
  if (process.env.FS === '1') require('node:fs').readFileSync(process.env.BUNDLE)
  for (let index = 0; index < 3; index++) {
    trace.getTracer('child').startSpan('work-' + index).end()
    await sleep(1200)
  }
  await handle.shutdown()
})()
`

/** Runs the child with the planted names and the options of the test. */
async function runChild(
  plant: Record<string, unknown>,
  extra: Record<string, string> = {}
): Promise<{ enabled: unknown; hooked: unknown }> {
  const result = await runInRealProcess(
    CHILD,
    {
      BUNDLE: bundle.file,
      PLANT: JSON.stringify(plant),
      OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint,
      ...extra
    },
    30_000
  )
  const answers = result.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  return Object.assign({ enabled: undefined, hooked: undefined }, ...answers) as {
    enabled: unknown
    hooked: unknown
  }
}

describe('a name that only the root prototype of the process holds does not decide the export', () => {
  it('sends the spans to the host endpoint, with no injected header and no compression', async () => {
    // Scenario: a planted endpoint, header list, compression and timeout, for the traces signal and for
    // all of them, do not redirect, decorate or compress what the host's own endpoint receives.
    const answer = await runChild({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:1/v1/traces',
      OTEL_EXPORTER_OTLP_HEADERS: 'x-planted=yes',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-planted-traces=yes',
      OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
      OTEL_EXPORTER_OTLP_TIMEOUT: '1'
    })
    expect(answer.enabled).toBe(true)
    expect(collector.bodies.join('')).toContain('work-2')
    for (const headers of collector.headers) {
      expect(headers['x-planted']).toBeUndefined()
      expect(headers['x-planted-traces']).toBeUndefined()
      expect(headers['content-encoding']).toBeUndefined()
    }
  }, 60_000)

  it('still samples, still runs and keeps the service name of the host', async () => {
    // Scenario: a planted sampler, a planted disable switch and a planted service name change neither
    // what is exported, nor whether the SDK runs, nor the name the host gave.
    const answer = await runChild({
      OTEL_TRACES_SAMPLER: 'always_off',
      OTEL_SDK_DISABLED: 'true',
      OTEL_SERVICE_NAME: 'planted-name'
    })
    expect(answer.enabled).toBe(true)
    expect(collector.bodies.join('')).toContain('work-0')
    expect(resourceAttributes(collector.bodies[0] ?? '')['service.name']).toBe('host-api')
  }, 60_000)

  it('records no request header the host did not ask for and runs no hook it did not give', async () => {
    // Scenario: a planted headersToSpanAttributes, request hook and response hook neither export the
    // Authorization header in clear nor run for a real request.
    const answer = await runChild(
      {
        headersToSpanAttributes: {
          server: { requestHeaders: ['authorization'] },
          client: { requestHeaders: ['authorization'] }
        }
      },
      {
        HTTP: '1',
        PLANT_SOURCE:
          'Object.prototype.requestHook = () => { globalThis.__hooked = true }; Object.prototype.responseHook = Object.prototype.requestHook'
      }
    )
    const joined = collector.bodies.join('')
    expect(joined).toContain('work-0')
    expect(joined).not.toContain('HOST-SECRET-123')
    expect(joined).not.toContain('http.request.header.authorization')
    expect(answer.hooked).toBe(false)
  }, 60_000)

  it('does not let a planted instrumentation name switch on what the host left off', async () => {
    // Scenario: a planted key named after the file-system instrumentation does not enable it for a host
    // that left it off, so no file-system span is exported for a file the child reads.
    await runChild({ '@opentelemetry/instrumentation-fs': { enabled: true } }, { FS: '1' })
    const joined = collector.bodies.join('')
    expect(joined).toContain('work-0')
    expect(joined).not.toContain('fs readFileSync')
  }, 60_000)
})
