import { context, propagation, trace } from '@opentelemetry/api'

import { shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'
import type { TelemetryHandle } from '@bymax-one/nest-telemetry'

import { spanAttributes, startCollector } from './fixtures/collector'
import type { Collector } from './fixtures/collector'

/** The secret every test plants; its bytes must not appear in anything exported. */
const SECRET = 'S3CR3T-VALUE-9f2c'

let collector: Collector
let started: TelemetryHandle | undefined

beforeEach(async () => {
  collector = await startCollector()
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = collector.endpoint
})

afterEach(async () => {
  await shutdownTelemetry()
  started = undefined
  // A started SDK leaves its global tracer provider, context manager and propagator registered, and
  // a second start in the same process cannot replace them, so each test releases them.
  trace.disable()
  context.disable()
  propagation.disable()
  delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  await collector.close()
})

/** Records one finished span through the real SDK pipeline, as an instrumentation would. */
function recordSpan(name: string, attributes: Record<string, string | number>): void {
  const span = trace.getTracer('e2e').startSpan(name, { attributes })
  span.end()
}

describe('span redaction through the real SDK', () => {
  it('exports no byte of a secret planted in any URL attribute, and keeps the paths', async () => {
    // Scenario: instrumentations record the request target under four attribute names, one of
    // which a span of another kind leaves unset or non-string; whatever they set, the secret must
    // be absent from the whole exported body, not merely from two keys.
    started = await startTelemetry({ env: {} })
    recordSpan('server', {
      'url.query': `token=${SECRET}&x=1`,
      'url.full': `https://api.example.test/reset?token=${SECRET}`,
      'http.url': `http://api.example.test/reset?token=${SECRET}`,
      'http.target': `/reset?token=${SECRET}`
    })
    recordSpan('plain', { 'http.method': 'GET' })
    recordSpan('clean-target', { 'url.full': 'https://api.example.test/health' })
    recordSpan('numeric-target', { 'url.full': 42 })
    await started.shutdown()

    const body = collector.bodies.join('\n')
    expect(body).not.toContain(SECRET)
    const server = spanAttributes(collector.bodies[0] ?? '', 'server')
    expect(server['url.query']).toBe('[redacted]')
    expect(server['url.full']).toBe('https://api.example.test/reset')
    expect(server['http.url']).toBe('http://api.example.test/reset')
    expect(server['http.target']).toBe('/reset')
    expect(spanAttributes(collector.bodies[0] ?? '', 'clean-target')['url.full']).toBe(
      'https://api.example.test/health'
    )
    expect(spanAttributes(collector.bodies[0] ?? '', 'numeric-target')['url.full']).toBe(42)
  })

  it('exports the URL attributes as recorded, and warns, when URL redaction is opted out', async () => {
    // Scenario: the explicit opt-out does something, which is what makes it an opt-out, and it
    // is loud: a process warning with the library code is emitted at boot.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    started = await startTelemetry({ env: {}, unsafe: { disableUrlRedaction: true } })
    recordSpan('server', { 'url.full': `/reset?token=${SECRET}` })
    await started.shutdown()

    expect(collector.bodies.join('\n')).toContain(SECRET)
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('URL redaction is disabled'), {
      type: 'SecurityWarning',
      code: 'BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED'
    })
  })
})
