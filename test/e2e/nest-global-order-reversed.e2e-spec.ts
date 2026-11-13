/**
 * @fileoverview Pins that a span another global module ends while the application closes is dropped when TelemetryModule is imported after it.
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
  it('drops the span another global module ends while closing when TelemetryModule is imported after it', async () => {
    // Scenario: The same application with TelemetryModule registered after the queue module closes it first: the flush has already run when the queue module ends its span, so the span is dropped. This pins the order dependence the README documents, so a change in Nest's ordering fails here instead of surprising a consumer.
    await startTelemetry({ serviceName: 'api', env: {} })
    const app = await Test.createTestingModule({
      imports: [QueueModule, TelemetryModule]
    }).compile()
    await app.init()
    await app.close()
    expect(collector.bodies.join('')).not.toContain('span-from-the-queue-module')
  })
})
