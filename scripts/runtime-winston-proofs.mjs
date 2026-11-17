/**
 * @fileoverview Real-process proof that winston records reach the logs pipeline when
 * `@opentelemetry/winston-transport` is installed, and that the library says so when it is not.
 * @layer scripts
 *
 * The winston instrumentation adds a transport from `@opentelemetry/winston-transport` with a
 * `require` when a logger is configured. Without that package it forwards nothing and only writes a
 * diagnostic note. Jest cannot show either outcome, because the instrumentation patches modules as
 * they load and Jest has its own module loader, so each run is a child process with `node --import`.
 *
 * Three runs against a local OTLP/JSON receiver:
 *
 * - the transport is installed: the winston record reaches the receiver and no warning is emitted;
 * - the transport is hidden from every `require`, as in a consumer that never installed it: the record
 *   does not reach the receiver, which is the control that shows the first run proves something, and
 *   the library emits `BYMAX_TELEMETRY_WINSTON_TRANSPORT_MISSING`;
 * - log sending is off: no record and no warning.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MARKER = 'winston-proof-marker'

/** A winston logger with a silent transport writes one record and lets the process end. */
const APP = `
import winston from 'winston'
const log = winston.createLogger({ transports: [new winston.transports.Console({ silent: true })] })
log.info('${MARKER}')
`

/** A preload that makes `@opentelemetry/winston-transport` unresolvable for every `require`. */
const HIDE_TRANSPORT = `
const Module = require('node:module')
const resolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === '@opentelemetry/winston-transport') {
    const error = new Error("Cannot find module '" + request + "'")
    error.code = 'MODULE_NOT_FOUND'
    throw error
  }
  return resolveFilename.call(this, request, ...rest)
}
`

/**
 * Runs the winston proofs against the package installed under `consumerDir`.
 *
 * @param {object} options - What the scenarios need.
 * @param {string} options.consumerDir - The consumer the tarball is unpacked in.
 * @param {string} options.packageName - The package under test.
 * @param {(args: string[], env?: Record<string, string>) => Promise<{ code: number, output: string, body: string }>} options.run - Runs one child process against the receiver.
 * @param {string[]} options.failures - Collects the failed assertions.
 * @returns {Promise<void>} Resolves when every proof ran.
 */
export async function runWinstonProofs({ consumerDir, packageName, run, failures }) {
  writeFileSync(join(consumerDir, 'winston-app.mjs'), APP)
  writeFileSync(join(consumerDir, 'hide-transport.cjs'), HIDE_TRANSPORT)
  const register = `${packageName}/register`
  const logs = {
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_BLRP_SCHEDULE_DELAY: '50',
    OTEL_METRICS_EXPORTER: 'none'
  }
  const scenarios = [
    {
      label: 'winston app, transport installed',
      args: ['--import', register, 'winston-app.mjs'],
      env: logs,
      forwarded: true,
      warned: false
    },
    {
      label: 'winston app, transport hidden',
      args: ['--require', './hide-transport.cjs', '--import', register, 'winston-app.mjs'],
      env: logs,
      forwarded: false,
      warned: true
    },
    {
      label: 'winston app, log sending off',
      args: ['--require', './hide-transport.cjs', '--import', register, 'winston-app.mjs'],
      env: { OTEL_METRICS_EXPORTER: 'none' },
      forwarded: false,
      warned: false
    }
  ]
  for (const { label, args, env, forwarded, warned } of scenarios) {
    const result = await run(args, env)
    const problems = []
    if (result.body.includes(MARKER) !== forwarded) {
      problems.push(
        forwarded
          ? 'the winston record did not reach the receiver'
          : 'a winston record reached the receiver'
      )
    }
    if (result.output.includes('BYMAX_TELEMETRY_WINSTON_TRANSPORT_MISSING') !== warned) {
      problems.push(
        warned
          ? 'the missing-transport warning was not emitted'
          : 'an unexpected missing-transport warning'
      )
    }
    if (result.code !== 0)
      problems.push(`the process exited ${result.code}: ${result.output.trim().slice(0, 300)}`)
    if (problems.length > 0) {
      failures.push(`${label}: ${problems.join('; ')}`)
    } else {
      console.log(
        `  ✓ ${label}: record ${forwarded ? 'forwarded' : 'not forwarded'}, warning ${warned ? 'emitted' : 'absent'}`
      )
    }
  }
}
