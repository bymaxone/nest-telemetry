/**
 * @fileoverview Pins that a span a global module ends while the application closes is exported when TelemetryModule is listed before the feature module that imports it.
 * @layer e2e
 */
import 'reflect-metadata'

import { Global, Injectable, Module } from '@nestjs/common'
import type { OnApplicationShutdown } from '@nestjs/common'
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

/** A provider of another global module that ends a span while the application closes. */
@Injectable()
class QueueDrain implements OnApplicationShutdown {
  public onApplicationShutdown(): void {
    trace.getTracer('e2e').startSpan('span-from-the-queue-module').end()
  }
}

@Global()
@Module({ providers: [QueueDrain] })
class QueueModule {}

/** A feature module that imports the global module, as a real application's modules do. */
@Module({ imports: [QueueModule] })
class FeatureModule {}

describe('TelemetryModule beside another global module', () => {
  it('delivers the span a global module ends while closing when TelemetryModule is listed before the feature module that imports it', async () => {
    // Scenario: The queue module is global but imported through a feature module. TelemetryModule listed first is still registered first, so it closes last and the span reaches the collector.
    await startTelemetry({ serviceName: 'api', env: {} })
    const app = await Test.createTestingModule({
      imports: [TelemetryModule, FeatureModule]
    }).compile()
    await app.init()
    await app.close()
    expect(collector.bodies.join('')).toContain('span-from-the-queue-module')
  })
})
