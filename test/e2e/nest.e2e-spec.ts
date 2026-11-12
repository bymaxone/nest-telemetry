import 'reflect-metadata'

import { Test } from '@nestjs/testing'
import { context, propagation, trace } from '@opentelemetry/api'

import { shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'
import { TelemetryModule } from '@bymax-one/nest-telemetry/nest'

import { startCollector } from './fixtures/collector'
import type { Collector } from './fixtures/collector'

let collector: Collector

beforeEach(async () => {
  jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  collector = await startCollector()
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = collector.endpoint
})

afterEach(async () => {
  await shutdownTelemetry()
  trace.disable()
  context.disable()
  propagation.disable()
  delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  await collector.close()
})

describe('TelemetryModule in a real Nest application', () => {
  it('delivers the spans still queued when the application closes', async () => {
    // Scenario: the SDK is started outside Nest, as a preload would, and a span is recorded; the
    // application closes with no explicit flush from the host. Nest awaits the module's hook, so
    // the queued span reaches the collector before close() resolves.
    const handle = await startTelemetry({ serviceName: 'api', env: {} })
    trace.getTracer('e2e').startSpan('work').end()
    const app = await Test.createTestingModule({ imports: [TelemetryModule] }).compile()
    await app.init()
    expect(collector.bodies).toHaveLength(0)
    await app.close()
    expect(collector.bodies).toHaveLength(1)
    expect(handle.enabled).toBe(true)
  })

  it('closes without effect when no SDK was started', async () => {
    // Scenario: telemetry is disabled, so the application closes as it always did.
    const app = await Test.createTestingModule({ imports: [TelemetryModule] }).compile()
    await app.init()
    await expect(app.close()).resolves.toBeUndefined()
    expect(collector.bodies).toHaveLength(0)
  })
})
