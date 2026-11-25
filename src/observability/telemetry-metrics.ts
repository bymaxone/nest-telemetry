/**
 * @fileoverview The metrics contributor that publishes how many span exports failed.
 * @layer nest
 *
 * The exporter wrapper counts every failed export on `globalThis`; the counter here reads that
 * count when the registry is scraped, so no export path calls `prom-client`.
 */
import { BymaxMetricsContributor } from '@bymax-one/nest-core/metrics'
import type { IMetricsContributor, MetricsRegistry } from '@bymax-one/nest-core/metrics'
import { Injectable } from '@nestjs/common'
import { Counter } from 'prom-client'

import { exportFailureCount } from '../sdk/export-failure'

/** The name of the counter, stable so an alert can match it. */
export const SPAN_EXPORT_FAILURES_METRIC = 'bymax_telemetry_span_export_failures_total'

/**
 * Publishes `bymax_telemetry_span_export_failures_total`, the number of span export batches the
 * collector did not accept, on the registry `BymaxCoreModule` hands every contributor. The counter
 * has no label.
 */
@BymaxMetricsContributor()
@Injectable()
export class TelemetryMetrics implements IMetricsContributor {
  /**
   * Registers the counter on the shared registry.
   *
   * @param registry - The registry the scrape endpoint serves.
   */
  registerMetrics(registry: MetricsRegistry): void {
    let published = 0
    new Counter({
      name: SPAN_EXPORT_FAILURES_METRIC,
      help: 'Span export batches the collector did not accept, so the batch was dropped.',
      registers: [registry],
      collect(): void {
        const total = exportFailureCount()
        // A count that went back (only a test harness resets it) adds nothing: a counter cannot fall.
        this.inc(Math.max(total - published, 0))
        published = total
      }
    })
  }
}
