#!/usr/bin/env node
/**
 * Dogfood smoke test — validates the published package shape before tagging.
 *
 * What this script validates:
 *   1. Build artifacts exist for every subpath (ESM, CJS, .d.ts)
 *   2. ESM import resolves all expected named exports
 *   3. CJS require resolves all expected named exports
 *   4. Tarball contents (via npm pack --dry-run output) contain only dist/ + meta files
 *   5. Scaffolds a minimal consumer in an OS temp dir (os.tmpdir()), installs
 *      via file: link, and verifies the package resolves from the consumer side
 *      through its published `exports` map
 *
 * Exit codes:
 *   0 — all assertions pass
 *   1 — one or more assertions failed (details printed to stderr)
 *   2 — build artifacts missing (run `pnpm build` first)
 *
 * Usage:
 *   pnpm build && node scripts/dogfood-smoke-test.mjs
 */

import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execSync, spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Created lazily inside section 6 (not at module load) so the earlier
// build-artifact check can `process.exit(2)` without leaking a temp dir.
let consumerDir

// Every published subpath and the names it must export. Phase 1 replaces the scaffold
// placeholder with each entry's real public API.
const EXPECTED_EXPORTS = {
  sdk: ['scaffoldMarker'],
  register: ['scaffoldMarker'],
  nest: ['scaffoldMarker']
}
const SUBPATHS = Object.keys(EXPECTED_EXPORTS)

const EXPECTED_DIST_FILES = SUBPATHS.flatMap((sub) =>
  ['mjs', 'cjs', 'd.ts', 'd.cts'].map((ext) => `dist/${sub}/index.${ext}`)
)

const ALLOWED_TARBALL_PATHS = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'dist/']

let failures = 0

function fail(msg) {
  console.error(`  FAIL: ${msg}`)
  failures++
}

function pass(msg) {
  console.log(`  PASS: ${msg}`)
}

function section(title) {
  console.log(`\n── ${title}`)
}

// ── 1. Build artifact presence ──────────────────────────────────────────────

section('1. Build artifacts')
for (const f of EXPECTED_DIST_FILES) {
  const abs = resolve(ROOT, f)
  if (!existsSync(abs)) {
    console.error(`Missing build artifact: ${f} — run \`pnpm build\` first.`)
    process.exit(2)
  }
  pass(f)
}

// ── 2. ESM named exports ────────────────────────────────────────────────────

section('2. ESM named exports')
for (const [sub, names] of Object.entries(EXPECTED_EXPORTS)) {
  const esm = await import(resolve(ROOT, `dist/${sub}/index.mjs`))
  for (const name of names) {
    if (name in esm) {
      pass(`${sub}: export ${name}`)
    } else {
      fail(`${sub}: missing export ${name}`)
    }
  }
}

// ── 3. CJS exports ──────────────────────────────────────────────────────────

section('3. CJS exports')
const { createRequire } = await import('node:module')
const req = createRequire(import.meta.url)
for (const [sub, names] of Object.entries(EXPECTED_EXPORTS)) {
  const cjs = req(resolve(ROOT, `dist/${sub}/index.cjs`))
  for (const name of names) {
    if (name in cjs) {
      pass(`${sub}: cjs export ${name}`)
    } else {
      fail(`${sub}: missing CJS export ${name}`)
    }
  }
}

// ── 5. Tarball contents ──────────────────────────────────────────────────────

section('5. Tarball contents (npm pack --dry-run)')
try {
  const packOut = execSync('npm pack --dry-run 2>&1', { cwd: ROOT, encoding: 'utf8' })
  // extract the paths listed under "Tarball Contents"
  // Lines with file sizes look like: "npm notice  2.4kB  CHANGELOG.md"
  // Match B, kB, KB, MB etc. Exclude metadata lines (shasum, integrity, total-files).
  const SIZE_RE = /\s+[\d.]+\s*(?:[Mm][Bb]|[Kk][Bb]?|[Bb])\s+\S+/
  const SIZE_STRIP_RE = /.*npm notice\s+[\d.]+\s*(?:[Mm][Bb]|[Kk][Bb]?|[Bb])\s+/
  const contentLines = packOut
    .split('\n')
    .filter((l) => l.includes('npm notice') && SIZE_RE.test(l))
    .map((l) => l.replace(SIZE_STRIP_RE, '').trim())
    .filter((l) => Boolean(l) && !l.startsWith('npm notice') && !/^sha\d+:/i.test(l))

  const unexpectedFiles = contentLines.filter(
    (f) => !ALLOWED_TARBALL_PATHS.some((prefix) => f === prefix || f.startsWith(prefix))
  )
  if (unexpectedFiles.length === 0) {
    pass(`Tarball contains only dist/ + meta files (${contentLines.length} entries)`)
  } else {
    for (const f of unexpectedFiles) {
      fail(`Unexpected file in tarball: ${f}`)
    }
  }
  // No cleanup needed: `npm pack --dry-run` never writes a .tgz to disk.
} catch (err) {
  fail(`npm pack --dry-run failed: ${String(err.message)}`)
}

// ── 6. Consumer file: link smoke ─────────────────────────────────────────────

section('6. Consumer file: link smoke (minimal resolution check)')
try {
  // Scaffold a minimal consumer in a unique, unpredictable temp dir (mkdtemp
  // appends random chars) — avoids the symlink/race hazards of a fixed /tmp
  // path. Created here, not at module load, so early exits leak nothing.
  consumerDir = mkdtempSync(join(tmpdir(), 'dogfood-consumer-'))
  const consumerPkgJson = {
    name: 'dogfood-consumer',
    version: '0.0.1',
    type: 'module',
    dependencies: {
      '@bymax-one/nest-telemetry': `file:${ROOT}`
    }
  }
  writeFileSync(resolve(consumerDir, 'package.json'), JSON.stringify(consumerPkgJson, null, 2))

  // Install via pnpm (resolves the file: link)
  const installResult = spawnSync('pnpm', ['install', '--no-frozen-lockfile'], {
    cwd: consumerDir,
    encoding: 'utf8',
    timeout: 60_000
  })
  if (installResult.status !== 0) {
    fail(`pnpm install in consumer failed: ${installResult.stderr}`)
  } else {
    pass('pnpm install with file: link succeeded')

    // Verify every subpath resolves from the consumer's node_modules
    for (const sub of SUBPATHS) {
      const consumerPath = resolve(
        consumerDir,
        `node_modules/@bymax-one/nest-telemetry/dist/${sub}/index.mjs`
      )
      if (existsSync(consumerPath)) {
        pass(`${sub} subpath resolves from consumer node_modules`)
      } else {
        fail(`${sub} subpath missing from consumer node_modules`)
      }
    }

    // Import by PACKAGE SPECIFIER from the consumer's cwd (not an absolute
    // path) so this exercises the published `exports` map exactly as a real
    // consumer's import would resolve it.
    const specifiers = ['', '/register', '/nest'].map(
      (suffix) => `@bymax-one/nest-telemetry${suffix}`
    )
    const specifierProbe =
      `Promise.all(${JSON.stringify(specifiers)}.map((s) => import(s)))` +
      ".then((all) => { if (all.some((m) => !('scaffoldMarker' in m))) process.exit(3) })" +
      '.catch((e) => { console.error(e); process.exit(5) })'
    const importResult = spawnSync('node', ['--input-type=module', '-e', specifierProbe], {
      cwd: consumerDir,
      encoding: 'utf8',
      timeout: 30_000
    })
    if (importResult.status === 0) {
      pass('package specifiers resolve via exports map from consumer cwd')
    } else {
      fail(
        `Consumer-side specifier import failed (code ${importResult.status}): ${importResult.stderr}`
      )
    }
  }
} catch (err) {
  fail(`Consumer scaffolding failed: ${String(err.message)}`)
} finally {
  // Cleanup (only if the temp dir was actually created)
  if (consumerDir) {
    try {
      rmSync(consumerDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
}

// ── Result ───────────────────────────────────────────────────────────────────

console.log('')
if (failures === 0) {
  console.log('✓ All dogfood smoke assertions passed.')
  process.exit(0)
} else {
  console.error(`✗ ${failures} assertion(s) failed.`)
  process.exit(1)
}
