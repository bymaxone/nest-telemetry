/**
 * @fileoverview Pins the public surface of the observability subpath.
 * @layer nest
 */
import * as observability from './index'

describe('the observability subpath', () => {
  it('exports the contributor and the metric name, and nothing else', () => {
    // Scenario: the surface is the class a host registers as a provider and the name it alerts on.
    expect(Object.keys(observability).sort()).toEqual([
      'SPAN_EXPORT_FAILURES_METRIC',
      'TelemetryMetrics'
    ])
    expect(typeof observability.TelemetryMetrics).toBe('function')
    expect(observability.SPAN_EXPORT_FAILURES_METRIC).toBe(
      'bymax_telemetry_span_export_failures_total'
    )
  })
})
