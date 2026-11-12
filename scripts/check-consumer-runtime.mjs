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
 * 1. `.` and `./register` load with NO `@nestjs/*` and NO OpenTelemetry SDK-graph package
 *    (`sdk-*`, `exporter-*`, `instrumentation*`, `resources`, `auto-instrumentations*`)
 *    resolvable. The SDK part is usable from plain Node, and a boot that is disabled
 *    loads no OpenTelemetry package: a resolution of either namespace is turned into a
 *    hard error by a resolve hook and recorded, so the gate fails on the first request
 *    rather than on a log line.
 * 2. `./nest` loads with `@nestjs/*` available and NO SDK-graph package resolvable:
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
 * The OpenTelemetry packages that make up the library's SDK graph. `@opentelemetry/api` is
 * deliberately absent: other libraries may load it, and it is inert without an SDK.
 */
const OTEL_SDK_GRAPH = [
  '@opentelemetry/sdk-',
  '@opentelemetry/exporter-',
  '@opentelemetry/instrumentation',
  '@opentelemetry/resources',
  '@opentelemetry/auto-instrumentations'
]

/** The probes: which subpaths load together, which namespaces are denied, what is exported. */
const PROBES = [
  {
    label: 'sdk without Nest or the OpenTelemetry SDK graph',
    deny: ['@nestjs/', ...OTEL_SDK_GRAPH],
    entries: { '.': ['scaffoldMarker'], './register': ['scaffoldMarker'] }
  },
  {
    label: 'nest without the OpenTelemetry SDK graph',
    deny: OTEL_SDK_GRAPH,
    entries: { './nest': ['scaffoldMarker'] }
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
const failures = []
for (const [subpath, names] of Object.entries(ENTRIES)) {
  const specifier = '${packageName}' + subpath.slice(1)
  const loaded = ${format === 'ESM' ? 'await import(specifier)' : 'require(specifier)'}
  const absent = names.filter((name) => !(name in loaded))
  if (absent.length > 0) failures.push(subpath + ' does not export: ' + absent.join(', '))
}
if (failures.length > 0) {
  for (const failure of failures) console.error('  ✗ ${format}: ' + failure)
  process.exit(1)
}
console.log('  ✓ ${format}: ' + Object.keys(ENTRIES).join(', ') + ' loaded and export their names')
`

const esmProbe = `${probeBody('ESM')}`
// In CommonJS the loaded set is also read back from `require.cache`, so the proof does not rest
// on the resolve hook alone.
const cjsProbe = `${probeBody('CJS')}
const DENY = JSON.parse(process.env.DENY_PREFIXES ?? '[]')
const leaked = Object.keys(require.cache).filter((file) =>
  DENY.some((prefix) => file.includes('node_modules/' + prefix))
)
if (leaked.length > 0) {
  console.error('  ✗ CJS: require.cache holds denied modules: ' + leaked.join(', '))
  process.exit(1)
}
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
        process.stdout.write(
          run('node', ['--import', './deny.mjs', file], {
            cwd: consumerDir,
            env: {
              ...process.env,
              DENY_PREFIXES: JSON.stringify(probe.deny),
              PROBE_ENTRIES: JSON.stringify(probe.entries)
            }
          })
        )
      } catch (error) {
        process.stdout.write(error.stdout ?? '')
        process.stderr.write(error.stderr ?? '')
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
