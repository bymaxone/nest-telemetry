/**
 * @fileoverview Pins that a span another global module ends while the application closes is exported when TelemetryModule is imported first.
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

describe('TelemetryModule beside another global module', () => {
  it('delivers the span another global module ends while closing when TelemetryModule is imported first', async () => {
    // Scenario: Nest closes global modules in the reverse of their registration order, so TelemetryModule, registered first, closes last: the span the queue module ends in its own shutdown hook is recorded before the flush and reaches the collector.
    await startTelemetry({ serviceName: 'api', env: {} })
    const app = await Test.createTestingModule({
      imports: [TelemetryModule, QueueModule]
    }).compile()
    await app.init()
    await app.close()
    expect(collector.bodies.join('')).toContain('span-from-the-queue-module')
  })
})
