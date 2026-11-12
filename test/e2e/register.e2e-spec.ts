import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { context, propagation, trace } from '@opentelemetry/api'

import { shutdownTelemetry } from '@bymax-one/nest-telemetry'

import { bootFromEnvironment } from '../../src/register/boot'

import { startCollector } from './fixtures/collector'
import type { Collector } from './fixtures/collector'

/** A URL inside this repository, from which `@opentelemetry/instrumentation` resolves. */
const PARENT = pathToFileURL(join(__dirname, 'preload.mjs')).href

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

describe('the preload boot with the real loader and the real SDK', () => {
  it('registers the loader hook, starts the SDK and flushes when the process runs out of work', async () => {
    // Scenario: the preload starts telemetry from the environment; a span recorded afterwards is
    // delivered when the process emits beforeExit, with no shutdown call from the application.
    const handle = await bootFromEnvironment(PARENT, { env: { OTEL_SERVICE_NAME: 'preload' } })
    expect(handle.enabled).toBe(true)
    trace.getTracer('e2e').startSpan('work').end()
    process.emit('beforeExit', 0)
    await expect(collector.waitForBodies(1, 3000)).resolves.toHaveLength(1)
  })

  it('warns and still starts when the loader hook cannot be resolved from the preload', async () => {
    // Scenario: the instrumentation peer is not installed beside the package; native ES modules
    // lose their spans, CommonJS keeps its, and the boot is not refused.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const handle = await bootFromEnvironment('file:///nonexistent-install/preload.mjs', {
      env: { OTEL_SERVICE_NAME: 'preload' }
    })
    expect(handle.enabled).toBe(true)
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('The OpenTelemetry loader hook could not be registered'),
      { type: 'Warning', code: 'BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE' }
    )
  })

  it('starts nothing and registers nothing when OTEL_SDK_DISABLED is true', async () => {
    // Scenario: a disabled boot costs nothing.
    const handle = await bootFromEnvironment(PARENT, { env: { OTEL_SDK_DISABLED: 'true' } })
    expect(handle.enabled).toBe(false)
    expect(collector.bodies).toHaveLength(0)
  })

  it('reads the process environment when given the parent URL alone', async () => {
    // Scenario: the preload file calls it with the parent URL alone.
    process.env['OTEL_SDK_DISABLED'] = 'true'
    try {
      expect((await bootFromEnvironment(PARENT)).enabled).toBe(false)
    } finally {
      delete process.env['OTEL_SDK_DISABLED']
    }
  })
})

describe('the CommonJS entry of ./register', () => {
  it('refuses to load', async () => {
    // Scenario: requiring the preload is an error that names `node --import`.
    await expect(import('../../src/register/require-stub')).rejects.toThrow('node --import')
  })
})
