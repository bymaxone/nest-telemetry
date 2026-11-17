/**
 * @fileoverview Pins that a ratio sampler without a usable ratio is reported at start, and that the
 * real SDK does sample every trace then, while a ratio of 0 to 1 is neither reported nor ignored.
 * @layer e2e
 */
import { context, propagation, trace } from '@opentelemetry/api'

import { shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'

import { allowRestart } from './fixtures/restart'

const CODE = 'BYMAX_TELEMETRY_SAMPLER_ARG_INVALID'
const SPANS = 200

/** How many of `SPANS` new root spans the running SDK samples. */
function sampledRoots(): number {
  let sampled = 0
  for (let i = 0; i < SPANS; i++) {
    const span = trace.getTracer('e2e').startSpan('root')
    if ((span.spanContext().traceFlags & 1) === 1) sampled += 1
    span.end()
  }
  return sampled
}

/** The process warnings with the sampler code. */
function samplerWarnings(emitWarning: jest.SpyInstance): unknown[][] {
  return emitWarning.mock.calls.filter(
    ([, options]) => (options as { code?: string }).code === CODE
  )
}

/** Starts the SDK with a sampler and its argument in the environment the SDK itself reads. */
async function startWith(sampler: string, arg: string | undefined): Promise<void> {
  process.env['OTEL_TRACES_SAMPLER'] = sampler
  if (arg === undefined) delete process.env['OTEL_TRACES_SAMPLER_ARG']
  else process.env['OTEL_TRACES_SAMPLER_ARG'] = arg
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:1'
  await startTelemetry({ serviceName: 'api', shutdownTimeoutMs: 100, env: process.env })
}

afterEach(async () => {
  await shutdownTelemetry()
  for (const name of [
    'OTEL_TRACES_SAMPLER',
    'OTEL_TRACES_SAMPLER_ARG',
    'OTEL_EXPORTER_OTLP_ENDPOINT'
  ]) {
    delete process.env[name]
  }
  trace.disable()
  context.disable()
  propagation.disable()
  allowRestart()
})

describe('a ratio sampler without a usable ratio', () => {
  it.each(['1.5', '-1', '10%', 'NaN', 'Infinity'])(
    'is reported once for %p, and the SDK samples every trace',
    async (arg) => {
      // Scenario: the SDK falls back to a ratio of 1 for each of these and says so only to its
      // diagnostic channel; the start says it through the warning route.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      await startWith('traceidratio', arg)
      expect(samplerWarnings(emitWarning)).toHaveLength(1)
      expect(String(samplerWarnings(emitWarning)[0]?.[0])).toContain('OTEL_TRACES_SAMPLER_ARG')
      expect(sampledRoots()).toBe(SPANS)
    }
  )

  it('is reported when the ratio is not set, and the SDK samples every trace', async () => {
    // Scenario: a ratio sampler named with no ratio, the typical gap in a deployment template.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    await startWith('parentbased_traceidratio', undefined)
    expect(samplerWarnings(emitWarning)).toHaveLength(1)
    expect(String(samplerWarnings(emitWarning)[0]?.[0])).toContain('not set')
    expect(sampledRoots()).toBe(SPANS)
  })
})

describe('a ratio sampler with a usable ratio', () => {
  it('is not reported, and the SDK keeps none of the traces for a ratio of 0', async () => {
    // Scenario: the control for the cases above. A ratio the library accepts is a ratio the SDK
    // applies, so 0 samples nothing and says nothing.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    await startWith('traceidratio', '0')
    expect(samplerWarnings(emitWarning)).toHaveLength(0)
    expect(sampledRoots()).toBe(0)
  })
})
