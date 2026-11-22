/**
 * @fileoverview Tests the check that warns when winston log forwarding is on but
 * `@opentelemetry/winston-transport` cannot be resolved from the winston instrumentation: the three
 * conditions, where each package is looked up from, and the real resolver on directory layouts.
 * @layer sdk
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  entryFile,
  resolveFrom,
  transportMissing,
  warnAboutMissingWinstonTransport
} from './winston-transport'
import type { Resolve } from './winston-transport'
import { clearWarningSink, registerWarningSink } from './warning-sink'

const ENTRY = '/app/dist/main.js'
const BUNDLE = '/app/node_modules/auto/index.js'
const INSTRUMENTATION = '/store/instrumentation-winston/index.js'
const TRANSPORT = '/app/node_modules/@opentelemetry/winston-transport/index.js'

/** A resolver over a fixed table of `id` looked up `from` a path. */
function table(entries: Readonly<Record<string, string>>): jest.MockedFunction<Resolve> {
  return jest.fn((id: string, from: string) => entries[`${id} from ${from}`])
}

const ALL = {
  [`winston from ${ENTRY}`]: '/app/node_modules/winston/index.js',
  [`@opentelemetry/auto-instrumentations-node from ${ENTRY}`]: BUNDLE,
  [`@opentelemetry/instrumentation-winston from ${BUNDLE}`]: INSTRUMENTATION,
  [`@opentelemetry/winston-transport from ${INSTRUMENTATION}`]: TRANSPORT
}

/** Everything except the entry named by `omit`. */
function without(omit: string): Record<string, string> {
  return Object.fromEntries(Object.entries(ALL).filter(([key]) => !key.startsWith(omit)))
}

describe('transportMissing', () => {
  it('is true when winston is installed and the transport does not resolve from the instrumentation', () => {
    // Scenario: the case that silently forwards nothing: winston and the instrumentation are there,
    // the transport is not.
    expect(transportMissing(ENTRY, table(without('@opentelemetry/winston-transport')))).toBe(true)
  })

  it('is false when the transport resolves from the instrumentation', () => {
    // Scenario: the host installed the transport, so winston records are forwarded.
    expect(transportMissing(ENTRY, table(ALL))).toBe(false)
  })

  it('is false when winston is not installed for the application', () => {
    // Scenario: an application without winston has nothing to forward, so a missing transport is
    // not worth a warning.
    // The transport is missing too, so only the absence of winston can make the answer false.
    const entries = Object.fromEntries(
      Object.entries(without('winston from')).filter(
        ([key]) => !key.startsWith('@opentelemetry/winston-transport')
      )
    )
    expect(transportMissing(ENTRY, table(entries))).toBe(false)
  })

  it('is false when the auto-instrumentations package is not found from the entry', () => {
    // Scenario: the instrumentation cannot be located, so the transport's absence is not certain.
    const resolve = table(without('@opentelemetry/auto-instrumentations-node'))
    expect(transportMissing(ENTRY, resolve)).toBe(false)
    expect(resolve).not.toHaveBeenCalledWith('@opentelemetry/winston-transport', expect.anything())
  })

  it('is false when the winston instrumentation is not found from the auto-instrumentations', () => {
    // Scenario: a bundle that does not carry the winston instrumentation has no transport to miss.
    expect(transportMissing(ENTRY, table(without('@opentelemetry/instrumentation-winston')))).toBe(
      false
    )
  })

  it('looks the transport up from the instrumentation, not from the entry', () => {
    // Scenario: the resolution that matters is the one the instrumentation makes, from its own
    // directory; a lookup from the entry would pass for a transport the instrumentation cannot see.
    const resolve = table(ALL)
    transportMissing(ENTRY, resolve)
    expect(resolve).toHaveBeenCalledWith('@opentelemetry/winston-transport', INSTRUMENTATION)
    expect(resolve).not.toHaveBeenCalledWith('@opentelemetry/winston-transport', ENTRY)
  })
})

describe('warnAboutMissingWinstonTransport', () => {
  let emitWarning: jest.SpyInstance

  beforeEach(() => {
    emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  })

  afterEach(() => {
    clearWarningSink()
  })

  it('warns once with a stable code, naming the package and the way out', () => {
    // Scenario: log sending is on and the transport is missing.
    warnAboutMissingWinstonTransport(
      true,
      ENTRY,
      table(without('@opentelemetry/winston-transport'))
    )
    expect(emitWarning).toHaveBeenCalledTimes(1)
    const [text, options] = emitWarning.mock.calls[0] as [string, { code: string }]
    expect(options.code).toBe('BYMAX_TELEMETRY_WINSTON_TRANSPORT_MISSING')
    expect(text).toContain('@opentelemetry/winston-transport')
    expect(text).toContain('direct dependency of the application')
    expect(text).toContain('instrumentations.sendLogs')
    expect(text).toContain('OTEL_LOGS_EXPORTER is none')
    expect(text).toContain('never creates a winston logger')
  })

  it('routes the warning through the registered sink', () => {
    // Scenario: a structured logger is bound, so the warning reaches it instead of the process.
    const sink = jest.fn(() => true)
    registerWarningSink(sink)
    warnAboutMissingWinstonTransport(
      true,
      ENTRY,
      table(without('@opentelemetry/winston-transport'))
    )
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'BYMAX_TELEMETRY_WINSTON_TRANSPORT_MISSING' })
    )
    expect(emitWarning).not.toHaveBeenCalled()
  })

  it('stays silent and resolves nothing when log sending is off', () => {
    // Scenario: nothing is forwarded either way, so the check does not even look.
    const resolve = table(without('@opentelemetry/winston-transport'))
    warnAboutMissingWinstonTransport(false, ENTRY, resolve)
    expect(emitWarning).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('reads the entry from the process and resolves with the real resolver by default', () => {
    // Scenario: the start passes only whether log sending is on. The process was started from a script
    // whose directory holds winston, the bundle and the winston instrumentation but not the
    // transport, so only a default entry that is the process script and a default resolver that
    // resolves real files can report it.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'winston-transport-default-')))
    const argv = process.argv
    try {
      const modules = join(root, 'node_modules')
      for (const dir of [
        join(modules, 'winston'),
        join(modules, '@opentelemetry', 'auto-instrumentations-node'),
        join(
          modules,
          '@opentelemetry',
          'auto-instrumentations-node',
          'node_modules',
          '@opentelemetry',
          'instrumentation-winston'
        )
      ]) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'package.json'), '{"name":"x","main":"index.js"}')
        writeFileSync(join(dir, 'index.js'), 'module.exports = {}')
      }
      process.argv = [argv[0] ?? 'node', join(root, 'main.js')]
      warnAboutMissingWinstonTransport(true)
    } finally {
      process.argv = argv
      rmSync(root, { recursive: true, force: true })
    }
    expect(emitWarning).toHaveBeenCalledTimes(1)
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('@opentelemetry/winston-transport'),
      {
        type: 'Warning',
        code: 'BYMAX_TELEMETRY_WINSTON_TRANSPORT_MISSING',
        detail: ''
      }
    )
  })

  it('stays silent when the transport resolves', () => {
    // Scenario: the host installed it.
    warnAboutMissingWinstonTransport(true, ENTRY, table(ALL))
    expect(emitWarning).not.toHaveBeenCalled()
  })
})

describe('entryFile', () => {
  it('is the script the process was started with', () => {
    // Scenario: `node app.js`, where the application's own node_modules is searched from app.js.
    expect(entryFile(['node', '/srv/app/main.js'], '/elsewhere')).toBe('/srv/app/main.js')
  })

  it('reads the script of this process when called with no arguments', () => {
    // Scenario: the start passes nothing, so the entry is the script the process was started with.
    const argv = process.argv
    process.argv = [argv[0] ?? 'node', '/srv/app/main.js']
    try {
      expect(entryFile()).toBe('/srv/app/main.js')
    } finally {
      process.argv = argv
    }
  })

  it('reads the working directory of this process when called with no arguments and no script', () => {
    // Scenario: `node -e` has no script, so the default working directory is the process's own.
    const argv = process.argv
    process.argv = [argv[0] ?? 'node']
    jest.spyOn(process, 'cwd').mockReturnValue('/srv/elsewhere')
    try {
      expect(entryFile()).toBe(join('/srv/elsewhere', 'entry.js'))
    } finally {
      process.argv = argv
    }
  })

  it('falls back to a file in the working directory when there is no script', () => {
    // Scenario: `node -e` or a REPL has no script; the working directory stands in for it.
    expect(entryFile(['node'], '/srv/app')).toBe(join('/srv/app', 'entry.js'))
  })
})

describe('resolveFrom, on real directories', () => {
  let root: string

  /** Writes a package with an `index.js` below `dir`. */
  function pkg(dir: string): string {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{"name":"x","main":"index.js"}')
    writeFileSync(join(dir, 'index.js'), 'module.exports = {}')
    return join(dir, 'index.js')
  }

  beforeEach(() => {
    // The real path, because a resolver returns real paths and a temporary directory can be a link.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'winston-transport-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('finds a package in a node_modules above the file', () => {
    // Scenario: winston installed beside the application.
    const winston = pkg(join(root, 'node_modules', 'winston'))
    expect(resolveFrom('winston', join(root, 'dist', 'main.js'))).toBe(winston)
  })

  it('returns undefined for a package that is not installed', () => {
    // Scenario: no winston anywhere above the file.
    expect(resolveFrom('winston-not-installed-here', join(root, 'dist', 'main.js'))).toBeUndefined()
  })

  it('finds the transport in the application node_modules from a store directory below it', () => {
    // Scenario: the pnpm layout, where the instrumentation sits in a store directory below the
    // application's node_modules and the walk reaches the application's own packages.
    const transport = pkg(join(root, 'node_modules', '@opentelemetry', 'winston-transport'))
    const instrumentation = pkg(
      join(root, 'node_modules', '.pnpm', 'i', 'node_modules', '@opentelemetry', 'iw')
    )
    expect(resolveFrom('@opentelemetry/winston-transport', instrumentation)).toBe(transport)
  })

  it('does not find a transport that sits beside the application and not above the instrumentation', () => {
    // Scenario: a transport that is installed elsewhere does not count.
    const instrumentation = pkg(join(root, 'a', 'node_modules', '@opentelemetry', 'iw'))
    pkg(join(root, 'b', 'node_modules', '@opentelemetry', 'winston-transport'))
    expect(resolveFrom('@opentelemetry/winston-transport', instrumentation)).toBeUndefined()
  })
})
