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

  it('refuses to start when a name is planted while the packages load, and removed after', async () => {
    // Scenario: the check is made again right before the SDK is built, so a name planted during the import and
    // gone once the start has answered still starts nothing.
    const pending = startTelemetry({ env: {} })
    Object.defineProperty(Object.prototype, 'plantedDuringTheImport', {
      value: 'x',
      enumerable: true,
      configurable: true,
      writable: true
    })
    try {
      const handle = await pending
      expect(handle.enabled).toBe(false)
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['plantedDuringTheImport']
    }
    trace.getTracer('e2e').startSpan('never-exported').end()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(collector.bodies).toHaveLength(0)
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

  it('counts one when the fresh realm cannot be built, as a realm that cannot be compared is not trusted', () => {
    // Scenario: the vm module throws while the fresh realm is built, at load and again at the first count; the
    // count is one, and neither the error nor what it said is shown.
    let count: number | undefined
    jest.isolateModules(() => {
      jest.doMock('node:vm', () => ({
        runInNewContext: (): never => {
          throw new Error('SECRET-FROM-THE-VM')
        }
      }))
      const guard = require('../../src/sdk/prototype-guard') as { pollutedNames(): number }
      count = guard.pollutedNames()
    })
    jest.dontMock('node:vm')
    expect(count).toBe(1)
  })

  it('leaves an object that has no exporter base class alone', () => {
    // Scenario: the wrap looks for the class an exporter extends; where there is none it does nothing.
    expect(() => guardExports(Object.create(null) as object)).not.toThrow()
    expect(() => guardExports({})).not.toThrow()
  })
})
