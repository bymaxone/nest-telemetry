/**
 * @fileoverview Pins that an export recorded while a name is planted on the root prototype is dropped by the
 * real exporter with nothing sent, and that the host goes on.
 * @layer e2e
 */
import { context, propagation, trace } from '@opentelemetry/api'

import { shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'

import { guardExports } from '../../src/sdk/export-guard'

import { startCollector } from './fixtures/collector'
import type { Collector } from './fixtures/collector'
import { allowRestart } from './fixtures/restart'

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
  allowRestart()
  delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  await collector.close()
})

describe('the export of the real exporter while a name is planted', () => {
  it('sends what was recorded on a clean prototype and drops what was recorded after a name was planted', async () => {
    // Scenario: telemetry starts clean; a name planted later makes the exporter refuse the next batch, with no
    // send and no error for the host, and the batch recorded before it arrived is already delivered.
    const handle = await startTelemetry({ env: { OTEL_BSP_SCHEDULE_DELAY: '100' } })
    expect(handle.enabled).toBe(true)
    trace.getTracer('e2e').startSpan('before-the-plant').end()
    await collector.waitForBodies(1, 5000)
    Object.defineProperty(Object.prototype, 'plantedAfterStart', {
      value: 'x',
      enumerable: true,
      configurable: true,
      writable: true
    })
    try {
      trace.getTracer('e2e').startSpan('after-the-plant').end()
      await new Promise((resolve) => setTimeout(resolve, 600))
      await handle.shutdown()
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['plantedAfterStart']
    }
    const joined = collector.bodies.join('')
    expect(joined).toContain('before-the-plant')
    expect(joined).not.toContain('after-the-plant')
  })

  it('refuses to start while a standard name of the root prototype is gone, as for a planted one', async () => {
    // Scenario: a realm that lacks a name the engine defines is as untrustworthy as one with an extra name.
    const before = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'isPrototypeOf'
    ) as PropertyDescriptor
    delete (Object.prototype as unknown as Record<string, unknown>)['isPrototypeOf']
    try {
      const handle = await startTelemetry({ env: {} })
      expect(handle.enabled).toBe(false)
    } finally {
      Object.defineProperty(Object.prototype, 'isPrototypeOf', before)
    }
  })

  it('leaves an object that has no exporter base class alone', () => {
    // Scenario: the wrap looks for the class an exporter extends; where there is none it does nothing.
    expect(() => guardExports(Object.create(null) as object)).not.toThrow()
    expect(() => guardExports({})).not.toThrow()
  })
})
