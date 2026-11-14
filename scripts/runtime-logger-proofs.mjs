/**
 * @fileoverview Real-process proof that the structured warning route does not feed itself.
 * @layer scripts
 *
 * A child process loads the preload with `node --import` and runs a Nest application whose bound
 * `TELEMETRY_LOGGER` writes each warning as a pino record. With `OTEL_LOGS_EXPORTER=otlp` the OTel
 * pino instrumentation forwards that record to the logs pipeline, so a logs exporter that reported
 * its own failures through the route would write a record that exports and can fail in turn. Jest
 * cannot show this: the pino instrumentation patches modules as they load, and Jest has its own
 * module loader.
 *
 * Two runs, both with the trace collector down:
 *
 * - the logs endpoint is up: the warning record reaches the receiver, which proves the logs pipeline
 *   was on and forwards what the logger writes, and the logger got exactly one export warning;
 * - the logs endpoint is down too: the logger still got exactly one warning and wrote exactly one
 *   record, however long the process ran, so a failed logs export reports nothing.
 */
import { createServer } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** @returns {Promise<number>} A port that was free a moment ago and has nothing listening now. */
async function closedPort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** A Nest application with a bound logger that writes each warning as a pino record. */
function appSource(packageName) {
  return `
import 'reflect-metadata'
import pino from 'pino'
import { trace } from '@opentelemetry/api'
import { Module } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { TELEMETRY_LOGGER, TelemetryModule } from '${packageName}/nest'

const records = []
const log = pino({ level: 'info' }, { write: (line) => records.push(line) })
const warns = []
const logger = {
  errorStructured: () => undefined,
  warnStructured: (key, message, _user, metadata) => {
    warns.push({ key, metadata })
    log.warn({ logKey: key, ...metadata }, message)
  }
}
class AppModule {}
Module({ imports: [TelemetryModule], providers: [{ provide: TELEMETRY_LOGGER, useValue: logger }] })(AppModule)
const app = await NestFactory.createApplicationContext(AppModule, { logger: false })
for (const name of ['first', 'second', 'third']) {
  trace.getTracer('proof').startSpan(name).end()
  await new Promise((resolve) => setTimeout(resolve, 400))
}
// Long enough for a feedback loop to show up as more records, many log batches later.
await new Promise((resolve) => setTimeout(resolve, 2000))
await app.close()
console.log('LOOP_RESULT ' + JSON.stringify({ warns, records: records.length }))
process.exit(0)
`
}

/** Reads the result line the app prints. */
function resultOf(output) {
  const line = output.split('\n').find((candidate) => candidate.startsWith('LOOP_RESULT '))
  return line === undefined ? undefined : JSON.parse(line.slice('LOOP_RESULT '.length))
}

/**
 * Runs the logger proofs against the package installed under `consumerDir`.
 *
 * @param {object} options - What the scenarios need.
 * @param {string} options.consumerDir - The consumer the tarball is unpacked in.
 * @param {string} options.packageName - The package under test.
 * @param {(args: string[], env?: Record<string, string>) => Promise<{ code: number, output: string, body: string }>} options.run - Runs one child process against the receiver.
 * @param {string[]} options.failures - Collects the failed assertions.
 * @returns {Promise<void>} Resolves when every proof ran.
 */
export async function runLoggerProofs({ consumerDir, packageName, run, failures }) {
  writeFileSync(join(consumerDir, 'logger-loop-app.mjs'), appSource(packageName))
  const register = `${packageName}/register`
  const base = {
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_TIMEOUT: '300',
    OTEL_BSP_SCHEDULE_DELAY: '50',
    OTEL_BLRP_SCHEDULE_DELAY: '50',
    OTEL_METRICS_EXPORTER: 'none'
  }

  const logsUp = await run(['--import', register, 'logger-loop-app.mjs'], {
    ...base,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${await closedPort()}/v1/traces`
  })
  const upResult = resultOf(logsUp.output)
  const before = failures.length
  const check = (ok, message) => {
    if (!ok) failures.push(`logger route, logs endpoint up: ${message}`)
  }
  check(upResult !== undefined, `the app printed no result: ${logsUp.output.trim().slice(0, 300)}`)
  check(upResult?.warns.length === 1, `expected one export warning, got ${upResult?.warns.length}`)
  check(
    upResult?.warns[0]?.key === 'TRACING_EXPORT_FAILED',
    'the warning was not under the export key'
  )
  check(
    logsUp.body.includes('TRACING_EXPORT_FAILED'),
    'the warning record did not reach the logs receiver, so the logs pipeline was not on'
  )
  if (failures.length === before) {
    console.log(
      '  ✓ logger route: one export warning reached the bound logger, and its record was forwarded to the logs pipeline'
    )
  }

  const bothDown = await run(['--import', register, 'logger-loop-app.mjs'], {
    ...base,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${await closedPort()}/v1/traces`,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${await closedPort()}/v1/logs`
  })
  const downResult = resultOf(bothDown.output)
  const downBefore = failures.length
  const downCheck = (ok, message) => {
    if (!ok) failures.push(`logger route, logs endpoint down: ${message}`)
  }
  downCheck(
    downResult !== undefined,
    `the app printed no result: ${bothDown.output.trim().slice(0, 300)}`
  )
  downCheck(
    downResult?.warns.length === 1,
    `expected one export warning, got ${downResult?.warns.length}`
  )
  downCheck(
    downResult?.records === 1,
    `expected one pino record, got ${downResult?.records}: a failed logs export reported itself`
  )
  if (failures.length === downBefore) {
    console.log(
      '  ✓ logger route, traces and logs both down: one warning and one record, so a failed logs export reports nothing'
    )
  }
}
