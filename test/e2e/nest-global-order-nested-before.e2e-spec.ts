/**
 * @fileoverview Pins that a span a global module ends while the application closes is dropped when the feature module that imports it is listed before TelemetryModule.
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
  it('drops the span a global module ends while closing when a feature module that imports it is listed before TelemetryModule', async () => {
    // Scenario: Registering the feature module registers the global queue module with it, ahead of TelemetryModule, so the flush runs first and the span is dropped.
    await startTelemetry({ serviceName: 'api', env: {} })
    const app = await Test.createTestingModule({
      imports: [FeatureModule, TelemetryModule]
    }).compile()
    await app.init()
    await app.close()
    expect(collector.bodies.join('')).not.toContain('span-from-the-queue-module')
  })
})
