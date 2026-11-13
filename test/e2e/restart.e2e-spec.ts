/**
 * @fileoverview Pins that a start after a shutdown is refused through the public API, and that the preload turns the refusal into a warning.
 * @layer e2e
 */
import { context, propagation, trace } from '@opentelemetry/api'

import { shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'

import { bootFromEnvironment } from '../../src/register/boot'

import { startCollector } from './fixtures/collector'
import type { Collector } from './fixtures/collector'

let collector: Collector

beforeEach(async () => {
  collector = await startCollector()
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = collector.endpoint
})

afterEach(async () => {
  trace.disable()
  context.disable()
  propagation.disable()
  delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  await collector.close()
})

describe('a start after a shutdown', () => {
  it('is refused by the public API and degrades to a warning in the preload', async () => {
    // Scenario: the refusal belongs to the library, not to the API globals: they are released
    // before the second start, which is refused all the same, so a consumer that restarts per
    // test hears it instead of exporting nothing. The preload turns the same refusal into a
    // warning and lets the application boot. Only the first SDK's span was ever exported.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    await startTelemetry({ serviceName: 'api', env: {} })
    trace.getTracer('e2e').startSpan('before-shutdown').end()
    await shutdownTelemetry()
    trace.disable()
    context.disable()
    propagation.disable()

    await expect(startTelemetry({ serviceName: 'api', env: {} })).rejects.toThrow('global setup')
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('cannot start again after it was shut down'),
      { type: 'Warning', code: 'BYMAX_TELEMETRY_RESTART_UNSUPPORTED' }
    )

    const handle = await bootFromEnvironment('file:///app/preload.mjs', {
      env: {},
      registerHook: () => undefined
    })
    expect(handle.enabled).toBe(false)
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('once per process'), {
      type: 'Warning',
      code: 'BYMAX_TELEMETRY_START_FAILED'
    })

    expect(collector.bodies).toHaveLength(1)
    expect(collector.bodies[0]).toContain('before-shutdown')
  })
})
