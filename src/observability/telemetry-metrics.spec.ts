/**
 * @fileoverview Tests the metrics contributor: the failed-export counter is published on the
 * registry it is handed, follows the count the exporter keeps and carries no label.
 * @layer nest
 */
import { BYMAX_METRICS_CONTRIBUTOR_METADATA } from '@bymax-one/nest-core/metrics'
import { Counter, Registry } from 'prom-client'

import { warnOnExportFailure } from '../sdk/export-failure'
import type { ObservableExporter } from '../sdk/export-failure'
import { TelemetryMetrics } from './telemetry-metrics'

const NAME = 'bymax_telemetry_span_export_failures_total'
const COUNT_KEY = Symbol.for('@bymax-one/nest-telemetry/export-failures')

/** Fails `times` exports through a watched exporter. */
function failExports(times: number): void {
  const exporter: ObservableExporter = { export: (_spans, done) => done({ code: 1 }) }
  warnOnExportFailure(exporter, 'otlp-http traces')
  for (let i = 0; i < times; i++) exporter.export([], () => undefined)
}

/** The value of the counter's one sample, or `undefined` when the scrape has none. */
async function sample(registry: Registry): Promise<string | undefined> {
  const text = await registry.metrics()
  return text.split('\n').find((line) => line.startsWith(`${NAME} `))
}

describe('TelemetryMetrics', () => {
  beforeEach(() => {
    jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    Reflect.deleteProperty(globalThis, COUNT_KEY)
  })

  it('is marked as a metrics contributor', () => {
    // Scenario: the core module finds contributors by this metadata and nothing else.
    expect(Reflect.getMetadata(BYMAX_METRICS_CONTRIBUTOR_METADATA, TelemetryMetrics)).toBe(true)
  })

  it('publishes the counter with its help text and a value of 0 before any failure', async () => {
    // Scenario: an alert on the counter needs the series to exist before the first failure.
    const registry = new Registry()
    new TelemetryMetrics().registerMetrics(registry)
    const text = await registry.metrics()
    expect(text).toContain(`# HELP ${NAME} `)
    expect(text).toContain(`# TYPE ${NAME} counter`)
    expect(await sample(registry)).toBe(`${NAME} 0`)
  })

  it('shows the failed exports after the scrape, with no label', async () => {
    // Scenario: three batches were dropped; the scrape reports three, and no label can grow.
    const registry = new Registry()
    new TelemetryMetrics().registerMetrics(registry)
    failExports(3)
    expect(await sample(registry)).toBe(`${NAME} 3`)
  })

  it('does not count a failure twice across scrapes', async () => {
    // Scenario: a second scrape with no new failure reports the same total, a later one adds only
    // what is new.
    const registry = new Registry()
    new TelemetryMetrics().registerMetrics(registry)
    failExports(2)
    await sample(registry)
    expect(await sample(registry)).toBe(`${NAME} 2`)
    failExports(1)
    expect(await sample(registry)).toBe(`${NAME} 3`)
  })

  it('counts the failures that happened before the contributor registered', async () => {
    // Scenario: the SDK starts at preload and the module registers later; early failures count.
    failExports(4)
    const registry = new Registry()
    new TelemetryMetrics().registerMetrics(registry)
    expect(await sample(registry)).toBe(`${NAME} 4`)
  })

  it('keeps scraping when the count went back, and adds only what is new after', async () => {
    // Scenario: a harness reset the count between two scrapes; the scrape must not throw, and the
    // counter must not fall.
    const registry = new Registry()
    new TelemetryMetrics().registerMetrics(registry)
    failExports(3)
    await sample(registry)
    Reflect.deleteProperty(globalThis, COUNT_KEY)
    expect(await sample(registry)).toBe(`${NAME} 3`)
    failExports(1)
    expect(await sample(registry)).toBe(`${NAME} 4`)
  })

  it('leaves the scrape text byte for byte as a counter that was never incremented, and as the scrape before', async () => {
    // Scenario: a scrape with nothing new adds 0; prom-client must show the same text as a counter nobody
    // touched on the first scrape, the same text as the scrape before when no failure came, and the same
    // text again when the count went back.
    const registry = new Registry()
    new TelemetryMetrics().registerMetrics(registry)
    const untouched = new Registry()
    new Counter({
      name: NAME,
      help: 'Span export batches the collector did not accept, so the batch was dropped.',
      registers: [untouched]
    })
    const first = await registry.metrics()
    expect(first).toBe(await untouched.metrics())
    expect(await registry.metrics()).toBe(first)
    failExports(2)
    const after = await registry.metrics()
    expect(after).not.toBe(first)
    expect(await registry.metrics()).toBe(after)
    Reflect.deleteProperty(globalThis, COUNT_KEY)
    expect(await registry.metrics()).toBe(after)
  })

  it('publishes only this one metric', async () => {
    // Scenario: the library adds one series and nothing that could grow without bound.
    const registry = new Registry()
    new TelemetryMetrics().registerMetrics(registry)
    expect(registry.getMetricsAsArray().map((metric) => metric.name)).toEqual([NAME])
  })

  it('fails the registration, naming the metric, when another component already claimed it', () => {
    // Scenario: prom-client refuses a duplicate name; the contributor lets it surface at boot.
    const registry = new Registry()
    new TelemetryMetrics().registerMetrics(registry)
    expect(() => new TelemetryMetrics().registerMetrics(registry)).toThrow(NAME)
  })
})
