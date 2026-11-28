/**
 * @fileoverview Pins what an `ignoreIncomingRequest` that is not synchronous does: on real requests
 * in a real process, and on the hook the instrumentation is configured with.
 * @layer e2e
 */
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'

import { buildInstrumentationConfig } from '../../src/sdk/assembly'

import { bundleSdk, runInRealProcess } from './fixtures/real-process'
import type { SdkBundle } from './fixtures/real-process'

const CODE = 'BYMAX_TELEMETRY_IGNORE_HOOK_ASYNC'
const HTTP = '@opentelemetry/instrumentation-http'

/**
 * Starts the SDK with the hook named by `HOOK`, serves two requests and prints what was exported.
 * The collector listens in the same process, on the port the endpoint names.
 */
const SCRIPT = `
const hooks = {
  sync: () => true,
  rejects: async () => { throw new Error('HOOK-SECRET') },
  resolvesTrue: async () => true,
  asyncThen: () => ({ async then() { throw new Error('HOOK-SECRET') } })
}
const codes = []
process.on('warning', (warning) => codes.push(warning.code))
const bodies = []
async function main() {
  const port = Number(process.env.PORT)
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:' + port
  const { startTelemetry } = require(process.env.BUNDLE)
  const handle = await startTelemetry({ serviceName: 'e2e', ignoreIncomingRequest: hooks[process.env.HOOK] })
  const http = require('node:http')
  const collector = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (req.url === '/v1/traces') bodies.push(Buffer.concat(chunks).toString('latin1'))
      res.end('{}')
    })
  })
  await new Promise((resolve) => collector.listen(port, '127.0.0.1', resolve))
  const app = http.createServer((req, res) => res.end('ok'))
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve))
  const statuses = []
  for (const path of ['/first', '/second']) {
    statuses.push(await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: app.address().port, path }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      }).on('error', reject)
    }))
  }
  await new Promise((resolve) => setTimeout(resolve, 200))
  await handle.shutdown()
  console.log(JSON.stringify({
    statuses,
    serverSpans: bodies.join('').includes('url.path'),
    warnings: codes.filter((code) => code === '${CODE}').length
  }))
  app.close()
  collector.close()
}
main()
`

/** A loopback port that was free a moment ago, for the collector the child starts. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** The warnings with the code of this suite among the process warnings emitted so far. */
function reports(emitWarning: jest.SpyInstance): unknown[][] {
  return emitWarning.mock.calls.filter(
    ([, options]) => (options as { code?: string }).code === CODE
  )
}

/** The hook the HTTP instrumentation is given for a host hook that answers with `answer`. */
function configuredHook(answer: () => unknown): (request: unknown) => unknown {
  const config = buildInstrumentationConfig(
    { ignoreIncomingRequest: answer as () => boolean },
    { overrides: {}, sendLogs: false }
  )
  const entry = config[HTTP] as Record<string, unknown>
  return entry['ignoreIncomingRequestHook'] as (request: unknown) => unknown
}

describe('the hook the instrumentation is configured with', () => {
  let emitWarning: jest.SpyInstance

  beforeEach(() => {
    emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([true, 'yes', null, { then: 'later' }])(
    'hands a synchronous answer of %p over as it is',
    (answer) => {
      // Scenario: only a thenable is treated differently.
      expect(configuredHook(() => answer)({})).toBe(answer)
      expect(reports(emitWarning)).toHaveLength(0)
    }
  )

  it.each([
    ['a promise', (): Promise<never> => Promise.reject(new Error('rejected'))],
    ['a thenable object', (): { then: () => void } => ({ then: (): void => undefined })],
    [
      'a thenable function',
      (): (() => void) & { then: () => void } =>
        Object.assign((): void => undefined, { then: (): void => undefined })
    ],
    [
      'a thenable whose then throws',
      (): { then: () => never } => ({
        then: (): never => {
          throw new Error('broken')
        }
      })
    ],
    [
      'a thenable whose then is async and rejects',
      (): { then(): Promise<never> } => ({
        async then(): Promise<never> {
          throw new Error('rejected')
        }
      })
    ]
  ])('does not ignore for %s, and reports the first only', (_kind, answer) => {
    // Scenario: every kind of thenable counts as "not ignored".
    const hook = configuredHook(answer)
    expect([hook({}), hook({})]).toEqual([false, false])
    expect(reports(emitWarning)).toHaveLength(1)
  })
})

describe('an ignoreIncomingRequest on real requests', () => {
  let bundle: SdkBundle

  beforeAll(() => {
    bundle = bundleSdk()
  }, 60_000)

  afterAll(() => {
    bundle.remove()
  })

  it.each([
    ['sync', false, 0],
    ['rejects', true, 1],
    ['resolvesTrue', true, 1],
    ['asyncThen', true, 1]
  ])(
    'with a %s hook keeps the process and serves the requests',
    async (hook, serverSpans, warnings) => {
      // Scenario: an unhandled rejection of the hook would end the process, and a promise taken
      // for `true` would drop every server span.
      const port = await freePort()
      const child = await runInRealProcess(
        SCRIPT,
        { BUNDLE: bundle.file, HOOK: hook, PORT: String(port) },
        20_000
      )
      expect(child.code).toBe(0)
      expect(JSON.parse(child.lines.at(-1) ?? '{}')).toEqual({
        statuses: [200, 200],
        serverSpans,
        warnings
      })
    },
    30_000
  )
})
