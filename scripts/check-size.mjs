#!/usr/bin/env node
// Zero-dependency bundle-size gate. Measures every published subpath's ESM
// bundle (raw + brotli-compressed) and fails when any subpath exceeds the
// hard-coded budget below.
//
// Why zero deps: this is a telemetry library that ships `"dependencies": {}` on
// purpose. The CI/release runner must stay free of third-party tooling so a
// compromised devDep cannot tamper with the bundle before `pnpm publish`.
// `node:zlib`'s brotli matches what npm/CDN compression produces on the wire.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Budgets are in bytes (KiB units, `n * 1024`, matching the table's ÷1024
// display) measured against the brotli'd .mjs bundle — what a consumer's
// bundler/CDN ships. Brotli, not gzip, to match real wire compression.
//
// Bymax bundle-size convention (canonical: Obsidian → 03 - Resources/NestJS/
// Bymax-Conventions.md → "Bundle-size budgets"):
//   1. The .mjs ships UNMINIFIED with JSDoc (tsup `minify: false`) on purpose —
//      readable stack traces / source inside a consumer's node_modules outweigh
//      a few KB on a backend lib that never reaches a browser. We do NOT minify
//      a lib just to satisfy a size budget.
//   2. The budget is CALIBRATED to the real built artifact + MODEST headroom:
//      enough to absorb normal inter-release growth, tight enough to catch
//      accidental bloat (e.g. a peer dep leaking into the bundle). It is a
//      bloat tripwire, NOT a hard design ceiling — when real growth is
//      legitimate, raise it (and say why here); when the artifact shrinks,
//      tighten it. Avoid >2x headroom: it silently lets bloat through.
//
// Calibration history (newest first):
//   - 2026-11-22 (sdk and register, PM-granted): sdk 8,242 B measured, 8.08 KiB budget (8,273 B, 31 B of
//     headroom); register 8,385 B, 8.22 KiB budget (8,417 B, 32 B). The growth, about 0.22 KiB in each, is the
//     placeholders on the process environment while the SDK is built, the configuration of the instrumentations
//     with no prototype and cut from the root prototype, and the reads of a Proxy and of the end of a chain.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 8,002 B measured, 7.83 KiB budget (8,018 B,
//     16 B of headroom); register 8,148 B, 7.98 KiB budget (8,172 B, 24 B). The growth, about 0.03 KiB in each, is
//     the read of every option of the call, and of every variable of an environment, with the rule that a key
//     only the root prototype of the realm holds is not the host's, and the copy of the call with no prototype.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 7,939 B measured, 7.77 KiB budget (7,956 B, 17 B of
//     headroom); register 8,100 B measured, 7.93 KiB budget (8,120 B, 20 B). The budget pays for the copy by
//     index and the guard of the host's lists, the kind checks of the object options by the brands Node
//     reports and a bounded chain of prototypes, and the test that keeps a flag held only by the root
//     prototype of the realm from being read as the host's.
//   - 2026-11-21 (sdk and register, PM-granted): sdk 7,241 B measured, 7.10 KiB budget (7,270 B,
//     29 B of headroom); register 7,534 B measured, 7.39 KiB budget (7,567 B, 33 B). The growth, about 0.05 KiB
//     in each, is the refusal of a `__proto__` key in an override.
//   - 2026-11-21 (sdk and register, PM-granted): sdk 7,187 B measured, 7.05 KiB budget (7,219 B,
//     32 B of headroom); register 7,488 B measured, 7.35 KiB budget (7,526 B, 38 B). The growth, about 0.16 KiB
//     in each, is the copy of each `overrides` entry and the kind check of its switches, list and hooks.
//   - 2026-11-21 (sdk and register, PM-granted): sdk 7,028 B measured, 6.90 KiB budget (7,066 B, 38 B of
//     headroom); register 7,308 B measured, 7.17 KiB budget (7,342 B, 34 B). The growth, about 0.7 KiB in each,
//     is the check of the kind of every option, with its error and the caps on lists and maps, and the single
//     read of each option of a call.
//   - observability: 673 B measured, 0.69 KiB budget (706 B, 33 B of headroom): the metrics contributor and
//     its one counter; `prom-client` and `@bymax-one/nest-core` stay external.
//   - sdk: 6,265 B measured, 6.15 KiB budget (6,297 B, 32 B of headroom), the whole subpath: redaction, the
//     environment reader, the SDK assembly, the resource-detector selection that keeps the process
//     command line out of the exported resource, the start cache and the handle lifecycle with its
//     shutdown deadline (about 0.1 KiB: the timer, its warning and the clamp of the configured
//     value), the export-failure warning (about 0.33 KiB: the exporter wrapper, the code reader and
//     the warning text), the warning sink (about 0.1 KiB), the resource attributes it removes and the timer values it refuses (about 0.27 KiB: the host-id wrapper, the timer ceiling and three warning texts), the refusal of a start after a shutdown and the warnings for a later call that
//     changes nothing, with their full explanatory text, and the winston transport check (about
//     0.38 KiB: the resolver, the three lookups and the warning text) and the sampler ratio check
//     (about 0.3 KiB: the ratio reader, the check and the warning text), the sampler name check (about
//     0.15 KiB: the six names, the near-miss reader and the warning text) and the dropping of absent option keys
//     before the merge with the defaults, each known option read by property access, and the count of
//     failed exports that the metrics contributor reads (about 0.06 KiB), and the failure description
//     that names a code and an OpenTelemetry package instead of echoing an error (about 0.04 KiB), and the escape of
//     direction, separator and invisible characters in a sampler value the warning repeats (about 0.12 KiB: the
//     category class, the escape and the single read of the unsafe options), and the single read of
//     the instrumentation options handed down to the steps (about 0.09 KiB), with a plain-object copy of the unsafe and
//     instrumentation options that reads each field once (about 0.08 KiB).
//   - register: 6,565 B measured, 6.44 KiB budget (6,594 B, 29 B of headroom). The preload bundles its own copy
//     of the start logic, shutdown deadline, export-failure warning, warning sink, resource and timer handling and the winston transport, sampler ratio and sampler name checks included: the copies share their state through
//     `globalThis`, not through a module.
//   - nest: 2,058 B measured, 2.04 KiB budget (2,089 B, 31 B of headroom), the global module and the shutdown hook
//     with every step of failure reporting guarded, the route that hands the two runtime warnings to
//     a bound structured logger, and the fallback entry that holds library text and a short error code
//     instead of the error's message and stack (about 0.1 KiB: the code reader and the longer text), and
//     the absorbed promise of an asynchronous logger (about 0.04 KiB), with the fallback report when it rejects
//     (about 0.17 KiB: the Nest logger entry as its own method, the process warning and the absorbing catch).
//   A budget is re-derived from the built artifact with modest headroom, never nudged, and never
//   met by shortening the text of a warning.
const BUDGETS = [
  { name: 'sdk (programmatic start)', path: 'dist/sdk/index.mjs', brotli: 8.08 * 1024 },
  { name: 'register (node --import)', path: 'dist/register/index.mjs', brotli: 8.22 * 1024 },
  { name: 'nest (module + shutdown)', path: 'dist/nest/index.mjs', brotli: 2.04 * 1024 },
  { name: 'observability (metrics)', path: 'dist/observability/index.mjs', brotli: 0.69 * 1024 }
]

const fmt = (n) => `${(n / 1024).toFixed(2)} kB`

const BROTLI_OPTS = {
  params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY }
}

// `PACKAGE_TARBALL` names the tarball a release gate has already packed: the bundles are read from
// the file that is published, not from `dist/`.
const TARBALL = process.env['PACKAGE_TARBALL']

/** The member names of the tarball, listed once. */
let tarballMembers

/**
 * Reads one built artifact, from the tarball when there is one, else from `dist/`.
 *
 * The listing of the tarball fails with `tar`'s own message on a file that is not a readable
 * archive, so only a member that is absent from a readable archive counts as a missing artifact.
 *
 * @param {string} path - The artifact path relative to the package root.
 * @returns {Buffer} The file content.
 */
function readArtifact(path) {
  if (TARBALL === undefined || TARBALL === '') return readFileSync(resolve(ROOT, path))
  tarballMembers ??= new Set(
    execFileSync('tar', ['-tzf', TARBALL], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split(
      '\n'
    )
  )
  if (!tarballMembers.has(`package/${path}`)) {
    throw Object.assign(new Error(`${path} is not in the tarball`), { code: 'ENOENT' })
  }
  return execFileSync('tar', ['-xzOf', TARBALL, `package/${path}`], {
    maxBuffer: 16 * 1024 * 1024
  })
}

let failed = 0
const rows = []

for (const { name, path, brotli: limit } of BUDGETS) {
  // Read straight away rather than testing for the file first. A `statSync`
  // followed by `readFileSync` states a fact about the past: the file can be
  // gone, replaced, or truncated between the two calls. `readFileSync` already
  // fails when the artifact is missing, so one call reports the same thing
  // without the window.
  let raw
  try {
    raw = readArtifact(path)
  } catch (error) {
    // Only a missing file earns the friendly message. A permission error or a
    // directory where a file belongs is a different problem, and reporting it as
    // "run pnpm build" sends the reader to the wrong place — rethrow so the real
    // code and stack reach the log.
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    console.error(`Missing build artifact: ${path} — run \`pnpm build\` first.`)
    process.exit(2)
  }
  const compressed = brotliCompressSync(raw, BROTLI_OPTS).length
  const ok = compressed <= limit
  if (!ok) failed += 1
  rows.push({
    name,
    raw: raw.length,
    brotli: compressed,
    limit,
    delta: compressed - limit,
    ok
  })
}

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

console.log('')
console.log(
  `  ${pad('Subpath', 38)}${padL('Raw', 12)}${padL('Brotli', 12)}${padL('Budget', 12)}  Status`
)
console.log(`  ${'-'.repeat(38)}${'-'.repeat(12)}${'-'.repeat(12)}${'-'.repeat(12)}  ------`)
for (const r of rows) {
  const status = r.ok ? 'PASS' : `FAIL +${fmt(r.delta)}`
  console.log(
    `  ${pad(r.name, 38)}${padL(fmt(r.raw), 12)}${padL(fmt(r.brotli), 12)}${padL(fmt(r.limit), 12)}  ${status}`
  )
}
console.log('')

if (failed > 0) {
  console.error(`${failed} subpath(s) exceeded the brotli budget.`)
  process.exit(1)
}
