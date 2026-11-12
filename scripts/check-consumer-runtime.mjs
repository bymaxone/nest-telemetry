#!/usr/bin/env node
/**
 * Consumer runtime gate.
 *
 * Every other gate reads the source or the type declarations. This one packs the
 * tarball, lays it out the way npm would, and loads each entry point from it — in ESM
 * and in CommonJS — because a defect in how the entry points are *bundled* is
 * invisible to all of them.
 *
 * What it proves, per module format:
 *
 * 1. `.` and `./register` load, and a start that is disabled — by the host or by
 *    OTEL_SDK_DISABLED — completes, with NO `@nestjs/*` and NO OpenTelemetry package
 *    (`api`, `sdk-*`, `exporter-*`, `instrumentation*`, `resources`, `auto-instrumentations*`)
 *    resolvable. The SDK part is usable from plain Node, and a boot that is disabled
 *    loads no OpenTelemetry package: a resolution of either namespace is turned into a
 *    hard error by a resolve hook and recorded, so the gate fails on the first request
 *    rather than on a log line.
 * 2. `./nest` loads with `@nestjs/*` available and NO OpenTelemetry package resolvable:
 *    the Nest part adds no OpenTelemetry cost of its own.
 * 3. Every entry exports the names its subpath promises.
 *
 * Entry points are separate bundles, so a module reached from two of them by a
 * relative path is copied into each, and a copied class is a different injection
 * token. These probes verify loading and export names; they do not verify instance
 * identity across entries.
 *
 * It shells out to `npm pack` and `tar`, both of which have to be on PATH. That is
 * deliberate: packing through npm itself is what makes the gate inspect the same
 * tarball a publish would produce, rather than a directory that resembles it.
 *
 * Usage: `node scripts/check-consumer-runtime.mjs` (run after `pnpm build`).
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
// Read from the manifest rather than hard-coded: this gate exists to inspect
// the packed artifact, so a rename must not leave it silently checking a
// package that no longer exists.
const packageName = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')).name

// The consumer lives inside the repository so Node walks up to the repo's own
// `node_modules` for the peer dependencies. Nothing is installed and nothing is
// fetched; only the package under test comes from the tarball.
const consumerDir = join(rootDir, '.consumer-runtime-check')

/**
 * The OpenTelemetry packages that make up the library's SDK graph, and the API package. A boot
 * with telemetry disabled loads none of them from this library: the API is inert without an SDK,
 * and other libraries may load it on their own, but this library has no reason to.
 */
const OTEL_PACKAGES = [
  '@opentelemetry/api',
  '@opentelemetry/sdk-',
  '@opentelemetry/exporter-',
  '@opentelemetry/instrumentation',
  '@opentelemetry/resources',
  '@opentelemetry/auto-instrumentations'
]

/**
 * The probes: which subpaths load together, which namespaces are denied, what is exported, which
 * calls are made and what they must return. `expectDenied` marks a positive control: the probe
 * must FAIL because the resolve hook fired, which proves the denial can see a load.
 */
const PROBES = [
  {
    label: 'sdk without Nest or any OpenTelemetry package, disabled by the host',
    deny: ['@nestjs/', ...OTEL_PACKAGES],
    entries: {
      '.': ['startTelemetry', 'shutdownTelemetry', 'ignorePaths', 'DEFAULT_REDACTED_QUERY_PARAMS'],
      './register': ['scaffoldMarker']
    },
    calls: [
      { entry: '.', fn: 'startTelemetry', args: [{ enabled: false }], expect: { enabled: false } },
      { entry: '.', fn: 'shutdownTelemetry', args: [], expect: {} }
    ]
  },
  {
    label: 'sdk without any OpenTelemetry package, disabled by OTEL_SDK_DISABLED',
    deny: ['@nestjs/', ...OTEL_PACKAGES],
    env: { OTEL_SDK_DISABLED: 'true' },
    entries: { '.': ['startTelemetry'] },
    calls: [{ entry: '.', fn: 'startTelemetry', args: [], expect: { enabled: false } }]
  },
  {
    label: 'positive control: an enabled start reaches the denied packages',
    deny: ['@nestjs/', ...OTEL_PACKAGES],
    entries: { '.': ['startTelemetry'] },
    calls: [{ entry: '.', fn: 'startTelemetry', args: [{}], expect: { enabled: true } }],
    expectDenied: true
  },
  {
    label: 'nest without any OpenTelemetry package',
    deny: OTEL_PACKAGES,
    entries: { './nest': ['scaffoldMarker'] },
    calls: []
  }
]

/** Resolve hook shared by both module formats (Node 24 `registerHooks` covers `require` too). */
const denyHook = `import { registerHooks } from 'node:module'
const deny = JSON.parse(process.env.DENY_PREFIXES ?? '[]')
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (deny.some((prefix) => specifier.startsWith(prefix))) {
      const error = new Error('denied resolution of ' + specifier)
      error.code = 'ERR_DENIED_BY_RUNTIME_GATE'
      throw error
    }
    return nextResolve(specifier, context)
  }
})
`

const probeBody = (format) => `
const ENTRIES = JSON.parse(process.env.PROBE_ENTRIES)
const CALLS = JSON.parse(process.env.PROBE_CALLS)
const load = (specifier) => ${format === 'ESM' ? 'import(specifier)' : 'Promise.resolve(require(specifier))'}
const specifierOf = (subpath) => '${packageName}' + subpath.slice(1)

async function run() {
  const failures = []
  for (const [subpath, names] of Object.entries(ENTRIES)) {
    const loaded = await load(specifierOf(subpath))
    const absent = names.filter((name) => !(name in loaded))
    if (absent.length > 0) failures.push(subpath + ' does not export: ' + absent.join(', '))
  }
  for (const call of CALLS) {
    const loaded = await load(specifierOf(call.entry))
    const result = await loaded[call.fn](...call.args)
    for (const [key, value] of Object.entries(call.expect)) {
      if (result?.[key] !== value) failures.push(call.fn + '() returned ' + key + '=' + result?.[key] + ', expected ' + value)
    }
  }
  return failures
}
`

const esmProbe = `${probeBody('ESM')}
try {
  const failures = await run()
  if (failures.length > 0) {
    for (const failure of failures) console.error('  ✗ ESM: ' + failure)
    process.exit(1)
  }
  console.log('  ✓ ESM: loaded, exports and calls as expected')
} catch (error) {
  console.error('  ✗ ESM: ' + (error && error.code ? error.code + ' ' : '') + (error && error.message))
  process.exit(1)
}
`
// In CommonJS the loaded set is also read back from `require.cache`, so the proof does not rest
// on the resolve hook alone.
const cjsProbe = `${probeBody('CJS')}
run()
  .then((failures) => {
    const DENY = JSON.parse(process.env.DENY_PREFIXES ?? '[]')
    const leaked = Object.keys(require.cache).filter((file) =>
      DENY.some((prefix) => file.includes('node_modules/' + prefix))
    )
    if (leaked.length > 0) failures.push('require.cache holds denied modules: ' + leaked.join(', '))
    if (failures.length > 0) {
      for (const failure of failures) console.error('  ✗ CJS: ' + failure)
      process.exit(1)
    }
    console.log('  ✓ CJS: loaded, exports and calls as expected')
  })
  .catch((error) => {
    console.error('  ✗ CJS: ' + (error && error.code ? error.code + ' ' : '') + (error && error.message))
    process.exit(1)
  })
`

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options })
}

function cleanup() {
  rmSync(consumerDir, { recursive: true, force: true })
}

console.log('Consumer runtime gate')

if (!existsSync(join(rootDir, 'dist'))) {
  console.error('✗ dist/ is missing — run `pnpm build` first')
  process.exit(1)
}

cleanup()
const packDir = mkdtempSync(join(tmpdir(), 'nest-telemetry-pack-'))
let failed = false

try {
  // `--ignore-scripts` keeps `prepublishOnly` from rebuilding underneath the
  // artifact this gate is meant to inspect.
  // The tarball is located by reading the directory it was packed into, not by
  // parsing `npm pack`'s stdout: inside a publish, npm writes notices around the
  // filename. The directory is freshly created and holds exactly one archive.
  // `npm_config_dry_run` is cleared for the child: a `npm publish --dry-run`
  // pre-flight exports it, the nested pack inherits it, and a dry pack writes no file.
  const packEnv = { ...process.env }
  delete packEnv['npm_config_dry_run']
  // `cwd: rootDir`: the package to pack is this repository's, whatever directory
  // the script was invoked from.
  run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', packDir], {
    cwd: rootDir,
    env: packEnv
  })
  const packed = readdirSync(packDir).filter((name) => name.endsWith('.tgz'))
  if (packed.length !== 1) {
    throw new Error(`expected one tarball in ${packDir}, found ${packed.length}`)
  }
  const tarball = join(packDir, packed[0])

  const packageDir = join(consumerDir, 'node_modules', packageName)
  mkdirSync(packageDir, { recursive: true })
  run('tar', ['-xzf', tarball, '-C', packageDir, '--strip-components=1'])

  writeFileSync(
    join(consumerDir, 'package.json'),
    `${JSON.stringify({ name: 'consumer-runtime-check', private: true, version: '0.0.0', type: 'module' }, null, 2)}\n`
  )
  writeFileSync(join(consumerDir, 'deny.mjs'), denyHook)
  writeFileSync(join(consumerDir, 'probe.mjs'), esmProbe)
  writeFileSync(join(consumerDir, 'probe.cjs'), cjsProbe)

  for (const probe of PROBES) {
    console.log(`  ${probe.label}`)
    for (const file of ['probe.mjs', 'probe.cjs']) {
      try {
        const output = run('node', ['--import', './deny.mjs', file], {
          cwd: consumerDir,
          env: {
            ...process.env,
            ...probe.env,
            DENY_PREFIXES: JSON.stringify(probe.deny),
            PROBE_ENTRIES: JSON.stringify(probe.entries),
            PROBE_CALLS: JSON.stringify(probe.calls)
          }
        })
        if (probe.expectDenied) {
          console.error(`  ✗ ${file}: the positive control passed, so the denial cannot see a load`)
          failed = true
        } else {
          process.stdout.write(output)
        }
      } catch (error) {
        const stderr = String(error.stderr ?? '')
        if (probe.expectDenied && stderr.includes('ERR_DENIED_BY_RUNTIME_GATE')) {
          console.log(`  ✓ ${file}: the denial fired, as the control requires`)
          continue
        }
        process.stdout.write(error.stdout ?? '')
        process.stderr.write(stderr)
        failed = true
      }
    }
  }
} catch (error) {
  console.error(`✗ gate setup failed: ${error.message}`)
  if (error.stderr) process.stderr.write(error.stderr)
  failed = true
} finally {
  cleanup()
  rmSync(packDir, { recursive: true, force: true })
}

if (failed) {
  console.error('\n✗ The published artifact does not work for a consumer.')
  process.exit(1)
}

console.log('✓ Every entry point loads in ESM and CommonJS under its dependency denials.')
