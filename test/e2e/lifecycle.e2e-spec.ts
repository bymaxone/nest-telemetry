import { context, propagation, trace } from '@opentelemetry/api'

import { shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'
import type { TelemetryHandle, TelemetryOptions } from '@bymax-one/nest-telemetry'

import { forceFlush, resourceAttributes, startCollector } from './fixtures/collector'
import type { Collector } from './fixtures/collector'

let collector: Collector

beforeEach(async () => {
  collector = await startCollector()
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = collector.endpoint
})

afterEach(async () => {
  await shutdownTelemetry()
  // A started SDK leaves its global tracer provider, context manager and propagator registered, and
  // a second start in the same process cannot replace them, so each test releases them.
  trace.disable()
  context.disable()
  propagation.disable()
  delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  delete process.env['OTEL_SDK_DISABLED']
  await collector.close()
})

/** Starts telemetry, records one span, and returns the handle. */
async function startAndRecord(options: TelemetryOptions): Promise<TelemetryHandle> {
  const handle = await startTelemetry(options)
  trace.getTracer('e2e').startSpan('work').end()
  return handle
}

describe('batch processor tuning from the standard variables', () => {
  it('exports a span without a shutdown when the schedule delay is short', async () => {
    // Scenario: OTEL_BSP_SCHEDULE_DELAY reaches the processor the library passes; at the default
    // of five seconds the span would still be queued, so its arrival proves the mapping.
    const handle = await startAndRecord({
      env: {
        OTEL_BSP_SCHEDULE_DELAY: '50',
        OTEL_BSP_MAX_QUEUE_SIZE: '2048',
        OTEL_BSP_EXPORT_TIMEOUT: '5000',
        OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '64'
      }
    })
    await expect(collector.waitForBodies(1, 3000)).resolves.toHaveLength(1)
    await handle.shutdown()
  })

  it('keeps the SDK defaults when the variables are unusable', async () => {
    // Scenario: blank, non-numeric, non-positive and infinite values are ignored, so the span
    // stays queued until shutdown flushes it.
    const handle = await startAndRecord({
      env: {
        OTEL_BSP_SCHEDULE_DELAY: 'abc',
        OTEL_BSP_MAX_QUEUE_SIZE: '0',
        OTEL_BSP_EXPORT_TIMEOUT: '-1',
        OTEL_BSP_MAX_EXPORT_BATCH_SIZE: 'Infinity'
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(collector.bodies).toHaveLength(0)
    await handle.shutdown()
    expect(collector.bodies).toHaveLength(1)
  })
})

describe('service identity on the exported resource', () => {
  it('prefers OTEL_SERVICE_NAME over the host name and carries the host version', async () => {
    // Scenario: the operator's standard override beats the name the code passed.
    const handle = await startAndRecord({
      serviceName: 'from-code',
      serviceVersion: '2.3.4',
      env: { OTEL_SERVICE_NAME: 'from-env' }
    })
    await handle.shutdown()
    expect(resourceAttributes(collector.bodies[0] ?? '')).toMatchObject({
      'service.name': 'from-env',
      'service.version': '2.3.4'
    })
  })

  it('treats a blank OTEL_SERVICE_NAME as absent', async () => {
    // Scenario: an empty variable must not erase the name the code passed.
    const handle = await startAndRecord({
      serviceName: 'from-code',
      env: { OTEL_SERVICE_NAME: '' }
    })
    await handle.shutdown()
    expect(resourceAttributes(collector.bodies[0] ?? '')['service.name']).toBe('from-code')
  })

  it('uses the host name when the environment does not override it', async () => {
    // Scenario: no OTEL_SERVICE_NAME, so the name the code passed is used.
    const handle = await startAndRecord({ serviceName: 'from-code', env: {} })
    await handle.shutdown()
    expect(resourceAttributes(collector.bodies[0] ?? '')['service.name']).toBe('from-code')
  })

  it('falls back to the specification default name and ignores blank values', async () => {
    // Scenario: with no name from either source the specification default applies; a blank host
    // name and version add nothing.
    const handle = await startAndRecord({ serviceName: '', serviceVersion: '', env: {} })
    await handle.shutdown()
    const attributes = resourceAttributes(collector.bodies[0] ?? '')
    expect(attributes['service.name']).toBe('unknown_service:node')
    expect(attributes).not.toHaveProperty('service.version')
  })
})

describe('enabling and disabling', () => {
  it.each([
    ['the host passes enabled:false', { enabled: false, env: {} }],
    ['OTEL_SDK_DISABLED is true', { env: { OTEL_SDK_DISABLED: 'true' } }],
    [
      'the host asks for enabled:true but OTEL_SDK_DISABLED is true',
      { enabled: true, env: { OTEL_SDK_DISABLED: 'TRUE' } }
    ]
  ] satisfies [string, TelemetryOptions][])('starts nothing when %s', async (_name, options) => {
    // Scenario: any one of the two off switches stops the SDK, and nothing is exported.
    const handle = await startAndRecord(options)
    await handle.shutdown()
    expect(handle.enabled).toBe(false)
    expect(collector.bodies).toHaveLength(0)
  })

  it('reads the process environment when started with no options', async () => {
    // Scenario: a bare call, as a minimal preload makes it, honours the process environment.
    process.env['OTEL_SDK_DISABLED'] = 'true'
    const handle = await startTelemetry()
    expect(handle.enabled).toBe(false)
  })

  it('delivers queued spans on a flush that does not stop the SDK', async () => {
    // Scenario: the span-end redaction sits in the processor chain, so a flush of the provider
    // reaches it and the exporter behind it, and spans arrive while the SDK keeps running.
    const handle = await startAndRecord({ env: {} })
    await forceFlush(trace.getTracerProvider())
    expect(collector.bodies).toHaveLength(1)
    await handle.shutdown()
  })

  it('stops the SDK once however often shutdown is called', async () => {
    // Scenario: a second shutdown, as a repeated signal would make, flushes nothing twice.
    const handle = await startAndRecord({ env: {} })
    await handle.shutdown()
    await handle.shutdown()
    expect(collector.bodies).toHaveLength(1)
  })

  it('leaves another registered handle alone when this one shuts down', async () => {
    // Scenario: a second copy of the library registered its own handle under the same symbol;
    // shutting this SDK down must not clear that registration.
    const key = Symbol.for('@bymax-one/nest-telemetry/handle')
    const store = globalThis as typeof globalThis & { [key]?: TelemetryHandle }
    const handle = await startTelemetry({ env: {} })
    const other: TelemetryHandle = { enabled: true, shutdown: () => Promise.resolve() }
    store[key] = other
    await handle.shutdown()
    expect(store[key]).toBe(other)
    delete store[key]
  })

  it('returns the running handle on a second start and drains through shutdownTelemetry', async () => {
    // Scenario: a repeated start does not start a second SDK, and the application drains the
    // SDK it never constructed, which delivers the queued span.
    const first = await startAndRecord({ env: {} })
    const second = await startTelemetry({ env: {} })
    expect(second).toBe(first)
    await shutdownTelemetry()
    expect(collector.bodies).toHaveLength(1)
  })
})
