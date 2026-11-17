/**
 * @fileoverview Pins that a real start reports a winston transport that cannot be resolved, once, and
 * stays silent when the transport resolves or log sending is off.
 * @layer e2e
 *
 * The layout is a real directory tree and `process.argv[1]` points into it, because Jest replaces
 * `createRequire` from `node:module` with its own resolver: patching Node's `Module._resolveFilename` to
 * hide the transport never reaches a lookup made under Jest.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { context, propagation, trace } from '@opentelemetry/api'

import { shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'

import { allowRestart } from './fixtures/restart'

const CODE = 'BYMAX_TELEMETRY_WINSTON_TRANSPORT_MISSING'
const TRANSPORT = '@opentelemetry/winston-transport'
const argv = process.argv
let root: string

/** Writes a package with an `index.js` below `dir`. */
function pkg(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"x","main":"index.js"}')
  writeFileSync(join(dir, 'index.js'), 'module.exports = {}')
}

/** What an application directory holds. */
interface Layout {
  readonly winston: boolean
  readonly bundle: boolean
  readonly instrumentation: boolean
  readonly transport: boolean
}

const COMPLETE: Layout = { winston: true, bundle: true, instrumentation: true, transport: false }

/**
 * An application directory the way a package manager lays it out: winston and the auto-instrumentations
 * package are the application's own, and the winston instrumentation sits below the bundle, where it
 * can see the application's `node_modules` but not a package that is not there.
 *
 * @returns The script the application is started from.
 */
function application(layout: Layout): string {
  const modules = join(root, 'app', 'node_modules')
  if (layout.winston) pkg(join(modules, 'winston'))
  const bundle = join(modules, '@opentelemetry', 'auto-instrumentations-node')
  if (layout.bundle) pkg(bundle)
  if (layout.instrumentation) {
    pkg(join(bundle, 'node_modules', '@opentelemetry', 'instrumentation-winston'))
  }
  if (layout.transport) pkg(join(modules, TRANSPORT))
  return join(root, 'app', 'main.js')
}

/** The process warnings with the winston transport code. */
function transportWarnings(emitWarning: jest.SpyInstance): unknown[][] {
  return emitWarning.mock.calls.filter(
    ([, options]) => (options as { code?: string }).code === CODE
  )
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'winston-transport-e2e-')))
})

afterEach(async () => {
  process.argv = argv
  await shutdownTelemetry()
  trace.disable()
  context.disable()
  propagation.disable()
  allowRestart()
  rmSync(root, { recursive: true, force: true })
})

describe('a start with winston log forwarding on', () => {
  it('warns once, naming the package, when the transport cannot be resolved', async () => {
    // Scenario: winston, the bundle and the winston instrumentation resolve from the application, and
    // the transport does not, so winston records would be dropped without a word.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    process.argv = [argv[0] ?? 'node', application(COMPLETE)]
    await startTelemetry({ serviceName: 'api', env: { OTEL_LOGS_EXPORTER: 'otlp' } })
    const warnings = transportWarnings(emitWarning)
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]?.[0])).toContain(TRANSPORT)
  })

  it('stays silent when the transport is installed for the application', async () => {
    // Scenario: the same layout with the transport beside winston, which the instrumentation finds.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    process.argv = [argv[0] ?? 'node', application({ ...COMPLETE, transport: true })]
    await startTelemetry({ serviceName: 'api', env: { OTEL_LOGS_EXPORTER: 'otlp' } })
    expect(transportWarnings(emitWarning)).toHaveLength(0)
  })

  it('stays silent when log sending is off, with the transport missing', async () => {
    // Scenario: no logs exporter is named, so no winston record would be forwarded either way.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    process.argv = [argv[0] ?? 'node', application(COMPLETE)]
    await startTelemetry({ serviceName: 'api', env: {} })
    expect(transportWarnings(emitWarning)).toHaveLength(0)
  })

  it.each([
    ['winston is not installed', { ...COMPLETE, winston: false }],
    ['the auto-instrumentations package is not installed', { ...COMPLETE, bundle: false }],
    ['the winston instrumentation cannot be found', { ...COMPLETE, instrumentation: false }]
  ])('stays silent when %s, because the answer is unknown', async (_name, layout) => {
    // Scenario: a lookup that fails before the transport's own leaves nothing certain to report.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    process.argv = [argv[0] ?? 'node', application(layout)]
    await startTelemetry({ serviceName: 'api', env: { OTEL_LOGS_EXPORTER: 'otlp' } })
    expect(transportWarnings(emitWarning)).toHaveLength(0)
  })

  it('looks from the working directory when the process has no script', async () => {
    // Scenario: `node -e` has no script. The working directory is this project, which has winston and
    // its transport installed, so the start is silent.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    process.argv = [argv[0] ?? 'node']
    await startTelemetry({ serviceName: 'api', env: { OTEL_LOGS_EXPORTER: 'otlp' } })
    expect(transportWarnings(emitWarning)).toHaveLength(0)
  })
})
