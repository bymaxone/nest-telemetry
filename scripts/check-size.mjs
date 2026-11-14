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
//   - sdk: 4.75 KiB real -> 4.80 KiB budget (~1% headroom), the whole subpath: redaction, the
//     environment reader, the SDK assembly, the resource-detector selection that keeps the process
//     command line out of the exported resource, the start cache and the handle lifecycle with its
//     shutdown deadline (about 0.1 KiB: the timer, its warning and the clamp of the configured
//     value), the export-failure warning (about 0.33 KiB: the exporter wrapper, the code reader and
//     the warning text), the warning sink (about 0.1 KiB), the resource attributes it removes and the timer values it refuses (about 0.27 KiB: the host-id wrapper, the timer ceiling and three warning texts), the refusal of a start after a shutdown and the warnings for a later call that
//     changes nothing, with their full explanatory text.
//   - register: 4.94 KiB real -> 4.99 KiB budget (~1% headroom). The preload bundles its own copy
//     of the start logic, shutdown deadline, export-failure warning, warning sink and resource and timer handling included: the copies share their state through
//     `globalThis`, not through a module.
//   - nest: 1.67 KiB real -> 1.72 KiB budget (~3% headroom), the global module and the shutdown hook
//     with every step of failure reporting guarded, and the route that hands the two runtime warnings to
//     a bound structured logger.
//   A budget is re-derived from the built artifact with modest headroom, never nudged, and never
//   met by shortening the text of a warning.
const BUDGETS = [
  { name: 'sdk (programmatic start)', path: 'dist/sdk/index.mjs', brotli: 4.8 * 1024 },
  { name: 'register (node --import)', path: 'dist/register/index.mjs', brotli: 4.99 * 1024 },
  { name: 'nest (module + shutdown)', path: 'dist/nest/index.mjs', brotli: 1.72 * 1024 }
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
