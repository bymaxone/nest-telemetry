/**
 * @fileoverview Pins that a collector which is down produces one warning per window, with no span data in it.
 * @layer e2e
 */
import { createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'

import { context, propagation, trace } from '@opentelemetry/api'
import { Registry } from 'prom-client'

import { shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'
import {
  SPAN_EXPORT_FAILURES_METRIC,
  TelemetryMetrics
} from '@bymax-one/nest-telemetry/observability'

import { allowRestart } from './fixtures/restart'

/** A port that was free a moment ago and has nothing listening now. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for('@bymax-one/nest-telemetry/export-failures'))
  for (const name of [
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_TIMEOUT',
    'OTEL_BSP_SCHEDULE_DELAY'
  ]) {
    delete process.env[name]
  }
  trace.disable()
  context.disable()
  propagation.disable()
  allowRestart()
})

describe('a collector that is down', () => {
  it('produces one export warning per window, naming the exporter and the error code only', async () => {
    // Scenario: every batch fails, and the application must hear about it. Three spans go out
    // in separate batches; the first failure warns and the rest fall inside the window.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const port = await closedPort()
    // The exporter reads the process environment, not the option.
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] =
      `http://operator:hunter2@127.0.0.1:${port}/?token=endpoint-secret`
    process.env['OTEL_EXPORTER_OTLP_TIMEOUT'] = '300'
    process.env['OTEL_BSP_SCHEDULE_DELAY'] = '50'
    await startTelemetry({ serviceName: 'api', shutdownTimeoutMs: 20_000, env: process.env })
    for (const name of ['first-secret-span', 'second-secret-span', 'third-secret-span']) {
      trace.getTracer('e2e').startSpan(name).end()
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    await shutdownTelemetry()
    const exportWarnings = emitWarning.mock.calls.filter(
      ([, options]) => (options as { code?: string }).code === 'BYMAX_TELEMETRY_EXPORT_FAILED'
    )
    expect(exportWarnings).toHaveLength(1)
    const text = String(exportWarnings[0]?.[0])
    expect(text).toContain('otlp-http traces')
    expect(text).toContain('code ECONNREFUSED')
    expect(text).not.toContain('secret-span')
    expect(text).not.toContain(String(port))
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('endpoint-secret')
  })

  it('names a failure that carries no code as UNKNOWN', async () => {
    // Scenario: a collector that accepts the connection and never answers ends in the exporter's own
    // timeout, an error without a code, so the warning says UNKNOWN rather than guessing.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const sockets: Socket[] = []
    const server: Server = createServer((socket) => {
      sockets.push(socket)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] =
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    process.env['OTEL_EXPORTER_OTLP_TIMEOUT'] = '300'
    process.env['OTEL_BSP_SCHEDULE_DELAY'] = '50'
    await startTelemetry({ serviceName: 'api', shutdownTimeoutMs: 20_000, env: process.env })
    trace.getTracer('e2e').startSpan('unanswered').end()
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await shutdownTelemetry()
    sockets.forEach((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const warned = emitWarning.mock.calls
      .filter(
        ([, options]) => (options as { code?: string }).code === 'BYMAX_TELEMETRY_EXPORT_FAILED'
      )
      .map(([text]) => String(text))
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('code UNKNOWN')
  })
})

describe('a collector that is down, seen through the metrics contributor', () => {
  it('counts every failed batch although the warning appears once', async () => {
    // Scenario: three spans go out in separate batches to a port with nothing listening. The warning
    // is limited to one a minute; the scrape of the registry shows every failed batch.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const registry = new Registry()
    new TelemetryMetrics().registerMetrics(registry)
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = `http://127.0.0.1:${await closedPort()}`
    process.env['OTEL_EXPORTER_OTLP_TIMEOUT'] = '300'
    process.env['OTEL_BSP_SCHEDULE_DELAY'] = '50'
    await startTelemetry({ serviceName: 'api', shutdownTimeoutMs: 20_000, env: process.env })
    for (const name of ['one', 'two', 'three']) {
      trace.getTracer('e2e').startSpan(name).end()
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    await shutdownTelemetry()
    const warnings = emitWarning.mock.calls.filter(
      ([, options]) => (options as { code?: string }).code === 'BYMAX_TELEMETRY_EXPORT_FAILED'
    )
    expect(warnings).toHaveLength(1)
    const scraped = await registry.metrics()
    const line = scraped.split('\n').find((it) => it.startsWith(`${SPAN_EXPORT_FAILURES_METRIC} `))
    expect(Number(line?.split(' ')[1])).toBeGreaterThanOrEqual(3)
    // A second scrape with no new failure reports the same total.
    expect(await registry.metrics()).toContain(line)
  })
})
