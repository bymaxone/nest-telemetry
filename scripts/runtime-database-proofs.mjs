/**
 * @fileoverview Real-process proofs for the database clients: a child process loads the preload
 * with `node --import`, runs one command through a real client, and a local receiver reads what
 * was exported.
 * @layer scripts
 *
 * Each proof has a negative control that proves its check can fail:
 *
 * - node-redis: the command name is exported and the planted argument and key are not. The control
 *   starts the SDK with the explicit opt-out, and the planted values then appear.
 * - mysql2: a value bound to a `?` placeholder must not reach `db.query.text`. This is a canary
 *   rather than a fix. `instrumentation-mysql2` formats bound values into the statement only when
 *   it holds mysql2's `format` function, and in the versions measured it is captured before the
 *   function is set, so the statement keeps its placeholders. The control calls the instrumentation's
 *   own statement builder with `format`, which shows the shape of the leak the proof would catch.
 *
 * The measurement behind the mysql2 proof holds for a known range; outside it the proof fails and
 * asks for a new measurement instead of passing on a claim nobody checked.
 */
import { createServer } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const REDIS_SCOPE = '@opentelemetry/instrumentation-redis'
const MYSQL2_SCOPE = '@opentelemetry/instrumentation-mysql2'
const NODE_REDIS_SECRET = 'NODE-REDIS-ARGV-SECRET-4c7d'
const NODE_REDIS_KEY = 'session:NODE-REDIS-KEY-9a2e'
const MYSQL_SECRET = 'MYSQL-BOUND-SECRET-6f1b'
const MYSQL_EMAIL = 'alice@example.invalid'
const MYSQL_STATEMENT = 'SELECT * FROM users WHERE email = ? AND token = ?'

/** The versions of `instrumentation-mysql2` and `mysql2` the claim in the README was measured on. */
const MEASURED = { instrumentation: [0, 71], mysql2: { from: [2, 3, 3], to: [3, 24, 6] } }

/** A node-redis application: one EVAL with a planted argument and key, outside any request. */
const NODE_REDIS_APP = `
const { createClient } = require('redis')
;(async () => {
  const client = createClient({ url: 'redis://127.0.0.1:' + process.env.PROBE_REDIS_PORT, RESP: 2 })
  client.on('error', () => undefined)
  await client.connect()
  await client.eval('return ARGV[1]', { keys: ['${NODE_REDIS_KEY}'], arguments: ['${NODE_REDIS_SECRET}'] })
  await client.disconnect()
  console.log('app done')
})()
`

/** A mysql2 application: one query with bound values, sent to a port nothing listens on. */
const MYSQL2_APP = `
const mysql = require('mysql2')
const connection = mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.PROBE_DEAD_PORT), user: 'probe' })
connection.on('error', () => undefined)
// The span is created when the query is issued, so it carries the statement text although the
// connection is refused.
connection.query('${MYSQL_STATEMENT}', ['${MYSQL_EMAIL}', '${MYSQL_SECRET}'], () => {
  connection.destroy()
  console.log('app done')
})
`

/** @returns {Promise<number>} A port that was free a moment ago and has nothing listening now. */
async function closedPort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Reads `major.minor.patch` out of a version string. */
function parts(version) {
  return version.split('.').map((part) => Number.parseInt(part, 10))
}

/** Compares two numeric version triples: negative, zero or positive. */
function compare(
  [leftMajor = 0, leftMinor = 0, leftPatch = 0],
  [rightMajor = 0, rightMinor = 0, rightPatch = 0]
) {
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch
}

/**
 * Reads the version of an installed package, and the directory its entry point lives in.
 *
 * @param {NodeRequire} require - A require anchored in the consumer.
 * @param {string} name - The package name.
 */
function installed(require, name) {
  const entry = require.resolve(name)
  let directory = dirname(entry)
  while (directory !== dirname(directory)) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
      if (manifest.name === name)
        return { version: manifest.version, entryDirectory: dirname(entry) }
    } catch {
      // No manifest in this directory: keep walking up.
    }
    directory = dirname(directory)
  }
  throw new Error(`no package.json named ${name} above ${entry}`)
}

/**
 * Runs the database proofs against the package installed under `consumerDir`.
 *
 * @param {object} options - What the scenarios need.
 * @param {string} options.consumerDir - The consumer the tarball is unpacked in.
 * @param {string} options.packageName - The package under test.
 * @param {(args: string[], env?: Record<string, string>) => Promise<{ code: number, output: string, body: string }>} options.run - Runs one child process against the receiver.
 * @param {string[]} options.failures - Collects the failed assertions.
 * @returns {Promise<void>} Resolves when every proof ran.
 */
export async function runDatabaseProofs({ consumerDir, packageName, run, failures }) {
  const require = createRequire(join(consumerDir, 'noop.cjs'))
  writeFileSync(join(consumerDir, 'node-redis-app.cjs'), NODE_REDIS_APP)
  writeFileSync(join(consumerDir, 'mysql2-app.cjs'), MYSQL2_APP)
  // The explicit opt-out, through the programmatic API: the preload reads only environment variables.
  // A programmatic start installs no flush of its own, so this one flushes when the process runs out
  // of work, as the preload does.
  writeFileSync(
    join(consumerDir, 'unsafe-redis-preload.mjs'),
    `const { startTelemetry, shutdownTelemetry } = await import('${packageName}')\n` +
      `await startTelemetry({ env: process.env, unsafe: { disableRedisArgumentRedaction: true } })\n` +
      `process.once('beforeExit', () => { void shutdownTelemetry() })\n`
  )
  const register = `${packageName}/register`

  const redis = await run(['--import', register, 'node-redis-app.cjs'])
  const before = failures.length
  const redisCheck = (ok, message) => {
    if (!ok) failures.push(`node-redis app with the preload: ${message}`)
  }
  redisCheck(
    redis.code === 0,
    `the application exited ${redis.code}: ${redis.output.trim().slice(0, 300)}`
  )
  redisCheck(
    redis.body.includes(REDIS_SCOPE),
    'no span from the redis instrumentation was exported'
  )
  redisCheck(
    !redis.body.includes(NODE_REDIS_SECRET),
    'the EVAL argument appears in the exported body'
  )
  redisCheck(!redis.body.includes(NODE_REDIS_KEY), 'the key appears in the exported body')
  redisCheck(redis.body.includes('"EVAL"'), 'the command name was not kept')
  if (failures.length === before) {
    console.log(
      '  ✓ node-redis app: spans exported with no active request, no argument or key, command name kept'
    )
  }

  const open = await run(['--import', './unsafe-redis-preload.mjs', 'node-redis-app.cjs'])
  const openBefore = failures.length
  if (!open.body.includes(NODE_REDIS_SECRET) || !open.body.includes(NODE_REDIS_KEY)) {
    failures.push(
      'node-redis app with the explicit opt-out: the planted values are not exported, so the control proves nothing'
    )
  }
  if (failures.length === openBefore) {
    console.log(
      '  ✓ negative control, node-redis with disableRedisArgumentRedaction: the planted values are exported'
    )
  }

  await runMysql2Proof({ require, run, failures, register })
}

/** The mysql2 canary, its negative control and the range check. */
async function runMysql2Proof({ require, run, failures, register }) {
  // `instrumentation-mysql2` is a dependency of the auto-instrumentation bundle, not of the consumer,
  // so it is resolved from the bundle's own location.
  const bundleRequire = createRequire(require.resolve('@opentelemetry/auto-instrumentations-node'))
  const instrumentation = installed(bundleRequire, MYSQL2_SCOPE)
  const driver = installed(require, 'mysql2')
  const [major, minor] = parts(instrumentation.version)
  const driverVersion = parts(driver.version)
  const inRange =
    major === MEASURED.instrumentation[0] &&
    minor === MEASURED.instrumentation[1] &&
    compare(driverVersion, MEASURED.mysql2.from) >= 0 &&
    compare(driverVersion, MEASURED.mysql2.to) <= 0
  if (!inRange) {
    failures.push(
      `mysql2 proof: instrumentation-mysql2 ${instrumentation.version} with mysql2 ${driver.version} is outside the measured range ` +
        '(instrumentation-mysql2 0.71.x with mysql2 2.3.3 to 3.24.6). Measure again whether a bound value reaches ' +
        'db.query.text, then update MEASURED here and the sentence in the README'
    )
    return
  }

  const result = await run(['--import', register, 'mysql2-app.cjs'], {
    PROBE_DEAD_PORT: String(await closedPort())
  })
  const before = failures.length
  if (result.code !== 0) {
    failures.push(
      `mysql2 app with the preload: exited ${result.code}: ${result.output.trim().slice(0, 300)}`
    )
  }
  if (!result.body.includes(MYSQL2_SCOPE)) {
    failures.push(
      'mysql2 app with the preload: no span from the mysql2 instrumentation was exported'
    )
  }
  if (!result.body.includes(MYSQL_STATEMENT)) {
    failures.push(
      `mysql2 app with the preload: the statement text "${MYSQL_STATEMENT}" was not exported`
    )
  }
  if (result.body.includes(MYSQL_SECRET) || result.body.includes(MYSQL_EMAIL)) {
    failures.push(
      'mysql2 app with the preload: a bound value reached db.query.text. instrumentation-mysql2 now formats ' +
        'bound values into the statement. This is the signal to mask by default: set maskStatement to true in ' +
        'buildInstrumentationConfig as a library-owned setting that a host override cannot undo, behind an ' +
        'unsafe option that warns, and say so in the README'
    )
  }
  if (failures.length === before) {
    console.log('  ✓ mysql2 app: the statement is exported with its placeholders, no bound value')
  }

  // The control: the instrumentation's own statement builder, given mysql2's `format`, does
  // interpolate bound values. That is the shape of the leak the proof above would catch.
  let leaked
  try {
    const { getQueryText } = bundleRequire(join(instrumentation.entryDirectory, 'utils.cjs'))
    leaked = getQueryText(MYSQL_STATEMENT, require('mysql2').format, [MYSQL_EMAIL, MYSQL_SECRET])
  } catch (error) {
    failures.push(
      `mysql2 control could not run: ${error.message}. instrumentation-mysql2 no longer exposes getQueryText from utils.cjs; update the control to the new statement builder`
    )
    return
  }
  if (typeof leaked === 'string' && leaked.includes(MYSQL_SECRET)) {
    console.log(
      '  ✓ negative control, mysql2 statement builder given format: the bound value is interpolated'
    )
  } else {
    failures.push(
      `mysql2 control: getQueryText with format returned ${JSON.stringify(leaked)} and no bound value, so the proof above can no longer fail. Re-measure the leak shape`
    )
  }
}
