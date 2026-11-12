/**
 * @fileoverview Real-process proofs for the packed package: a child process loads the preload with
 * `node --import`, makes a real HTTP request and a real Redis command, and a local receiver reads
 * what was exported.
 * @layer scripts
 *
 * Jest cannot run these. OpenTelemetry patches modules as they load, and Jest has its own module
 * loader, so no instrumentation fires in the test process; the preload is also a top-level-await
 * module that Jest's CommonJS transform cannot compile. They run against the unpacked tarball, so
 * they judge what a consumer installs.
 *
 * Every secret planted below must be absent from the whole exported body, while the facts that must
 * stay (the Redis command name, the HTTP spans) are present. The negative controls prove the checks
 * can fail: no preload, no loader hook, and a preload that loads too late all export no HTTP span.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const QUERY_SECRET = 'QUERY-SECRET-5d1e'
const REDIS_SECRET = 'REDIS-ARGV-SECRET-8b3a'
const HTTP_SCOPE = '@opentelemetry/instrumentation-http'
const IOREDIS_SCOPE = '@opentelemetry/instrumentation-ioredis'

/** An OTLP/HTTP receiver that keeps every body it is sent. */
async function startReceiver() {
  const bodies = []
  const server = createServer((request, response) => {
    let data = ''
    request.on('data', (chunk) => {
      data += chunk.toString('utf8')
    })
    request.on('end', () => {
      bodies.push(data)
      response.setHeader('content-type', 'application/json')
      response.end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    bodies,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

/**
 * A minimal Redis that answers every command with `+OK`, so a real client can run commands
 * against it. It parses just enough RESP to find where one command ends.
 */
async function startFakeRedis() {
  const server = createTcpServer((socket) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1')
      for (;;) {
        const match = /^\*(\d+)\r\n/.exec(buffer)
        if (!match) return
        let offset = match[0].length
        const parts = []
        for (let index = 0; index < Number(match[1]); index += 1) {
          const header = /^\$(\d+)\r\n/.exec(buffer.slice(offset))
          if (!header) return
          const start = offset + header[0].length
          const end = start + Number(header[1])
          if (buffer.length < end + 2) return
          parts.push(buffer.slice(start, end))
          offset = end + 2
        }
        buffer = buffer.slice(offset)
        socket.write('+OK\r\n')
      }
    })
    socket.on('error', () => undefined)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

/** The body of the app both module formats run: a real HTTP request and a real Redis command. */
const APP_BODY = `
const redisPort = Number(process.env.PROBE_REDIS_PORT)
const redis = new Redis({ host: '127.0.0.1', port: redisPort, enableReadyCheck: false, maxRetriesPerRequest: 1, retryStrategy: () => null, protocol: 2 })
// The Redis command runs inside the request handler: the ioredis instrumentation traces a command
// only when a span is already active, which is the case in a real request.
const server = http.createServer(async (request, response) => {
  await redis.eval('return ARGV[1]', 0, '${REDIS_SECRET}')
  response.end('ok')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()
await new Promise((resolve, reject) => {
  http.get('http://127.0.0.1:' + port + '/reset?token=${QUERY_SECRET}', (response) => {
    response.resume()
    response.on('end', resolve)
  }).on('error', reject)
})
server.close()
redis.disconnect()
console.log('app done')
`

/** Writes the app in both module formats, and the preloads the scenarios use. */
function writeFixtures(consumerDir, packageName) {
  writeFileSync(
    join(consumerDir, 'app.mjs'),
    `import http from 'node:http'\nimport { Redis } from 'ioredis'\n${APP_BODY}`
  )
  writeFileSync(
    join(consumerDir, 'app.cjs'),
    `const http = require('node:http')\nconst { Redis } = require('ioredis')\n;(async () => {${APP_BODY}})()\n`
  )
  // A preload that starts the SDK through the programmatic API and registers no loader hook.
  writeFileSync(
    join(consumerDir, 'no-hook-preload.mjs'),
    `const { startTelemetry } = await import('${packageName}')\nawait startTelemetry({ env: process.env })\n`
  )
  // An application that loads `ioredis` first and the preload after it, the order that must not work.
  writeFileSync(
    join(consumerDir, 'late-app.cjs'),
    `const { Redis } = require('ioredis')\nconst http = require('node:http')\n;(async () => {\nawait import('${packageName}/register')\n${APP_BODY}})()\n`
  )
}

/** Runs one child process and returns what the receiver saw. */
async function runScenario({ consumerDir, receiver, redis, args, env }) {
  const before = receiver.bodies.length
  const child = spawn(process.execPath, args, {
    cwd: consumerDir,
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${receiver.port}`,
      OTEL_SERVICE_NAME: 'runtime-proof',
      PROBE_REDIS_PORT: String(redis.port),
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  const code = await new Promise((resolve) => child.on('close', resolve))
  return { code, output, body: receiver.bodies.slice(before).join('\n') }
}

/** The assertions of an instrumented run: spans exported, secrets absent, the command name kept. */
function expectInstrumented(label, { code, output, body }, failures) {
  const check = (ok, message) => {
    if (!ok) failures.push(`${label}: ${message}`)
  }
  check(
    code === 0,
    `the application exited ${code}: ${output.trim().split('\n').slice(0, 12).join(' | ')}`
  )
  check(body.includes(HTTP_SCOPE), 'no span from the HTTP instrumentation was exported')
  check(body.includes(IOREDIS_SCOPE), 'no span from the ioredis instrumentation was exported')
  check(!body.includes(QUERY_SECRET), 'the query secret appears in the exported body')
  check(!body.includes(REDIS_SECRET), 'the Redis EVAL argument appears in the exported body')
  check(body.includes('"eval"') || body.includes('"EVAL"'), 'the Redis command name was not kept')
  check(body.includes('[redacted]'), 'no redaction marker was exported')
}

/**
 * Runs every proof against the package installed under `consumerDir`.
 *
 * @param {{ consumerDir: string, packageName: string }} options - Where the tarball is unpacked.
 * @returns {Promise<string[]>} The failed assertions; empty when every proof holds.
 */
export async function runInstrumentationProofs({ consumerDir, packageName }) {
  writeFixtures(consumerDir, packageName)
  const receiver = await startReceiver()
  const redis = await startFakeRedis()
  const failures = []
  const run = (args, env = {}) => runScenario({ consumerDir, receiver, redis, args, env })
  try {
    const register = `${packageName}/register`

    expectInstrumented(
      'CommonJS app with the preload',
      await run(['--import', register, 'app.cjs']),
      failures
    )
    console.log('  ✓ CommonJS app with the preload: spans exported, no secret, command name kept')

    expectInstrumented(
      'native-ESM app with the preload',
      await run(['--import', register, 'app.mjs']),
      failures
    )
    console.log('  ✓ native-ESM app with the preload: spans exported, no secret, command name kept')

    // Each control names the span that must be missing, which is what the check can lose without
    // the property it guards. The core `http` module is patched even when the preload loads late,
    // so ordering is judged on `ioredis`, a module the application loads itself.
    const controls = [
      [
        'native-ESM app, SDK started with no loader hook',
        ['--import', './no-hook-preload.mjs', 'app.mjs'],
        {},
        HTTP_SCOPE
      ],
      ['CommonJS app, no preload', ['app.cjs'], {}, HTTP_SCOPE],
      ['CommonJS app, preload loaded after ioredis', ['late-app.cjs'], {}, IOREDIS_SCOPE],
      [
        'CommonJS app, OTEL_SDK_DISABLED=true',
        ['--import', register, 'app.cjs'],
        { OTEL_SDK_DISABLED: 'true' },
        HTTP_SCOPE
      ]
    ]
    for (const [label, args, env, missing] of controls) {
      const result = await run(args, env)
      const before = failures.length
      if (result.body.includes(missing))
        failures.push(`${label}: exported ${missing}, so the control proves nothing`)
      if (result.body.includes(QUERY_SECRET) || result.body.includes(REDIS_SECRET)) {
        failures.push(`${label}: a secret appears in the exported body`)
      }
      if (failures.length === before)
        console.log(`  ✓ negative control, ${label}: no ${missing} span`)
    }
  } finally {
    await receiver.close()
    await redis.close()
  }
  return failures
}
