/**
 * @fileoverview Tests that the `size` script runs the stale-build guard on every file the build reads:
 * the config of the bundler, the manifest and each tsconfig, so a change to one of them after a build
 * is refused and cannot be measured against the old bundles.
 * @layer scripts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const GUARD = join(ROOT, 'scripts', 'check-dist-fresh.mjs')
const roots = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The arguments the `size` script passes to the guard, as written in package.json. */
function guardArguments() {
  const size = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.size
  const guard = size.split('&&').find((step) => step.includes('check-dist-fresh.mjs'))
  assert.ok(guard, 'the size script runs the guard')
  return guard.trim().split(/\s+/).slice(2)
}

/** A throwaway package with a build and the files the guard is given, every one of them at second 100. */
function pkg(files, mtimes = {}) {
  const root = mkdtempSync(join(tmpdir(), 'size-wiring-'))
  roots.push(root)
  const seconds = { 'src/a.ts': 100, 'dist/a.mjs': 200, ...mtimes }
  for (const path of ['src/a.ts', 'dist/a.mjs', ...files]) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), 'x')
    const time = seconds[path] ?? 100
    utimesSync(join(root, path), time, time)
  }
  return root
}

const run = (root) =>
  spawnSync(process.execPath, [GUARD, ...guardArguments()], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH }
  })

/** The files the build reads: the tsconfig that tsup names in its config, and the one it extends. */
function buildFiles() {
  const named = readFileSync(join(ROOT, 'tsup.config.ts'), 'utf8').match(
    /tsconfig:\s*'([^']+)'/
  )?.[1]
  assert.ok(named, 'tsup names a tsconfig')
  return ['tsup.config.ts', 'package.json', named, 'tsconfig.json']
}

describe('the size script', () => {
  it('passes the guard every file the build reads, and passes a build newer than all of them', () => {
    // Scenario: the control: with every build input older than the bundles the guard is satisfied.
    assert.equal(run(pkg(buildFiles())).status, 0)
  })

  it('refuses a bundle older than a tsconfig the build reads, for each of them', () => {
    // Scenario: touching a tsconfig after the build leaves the bundles stale, and the guard says so.
    for (const file of buildFiles()) {
      const result = run(pkg(buildFiles(), { [file]: 300 }))
      assert.equal(result.status, 1, `${file} newer than the build must fail`)
    }
  })
})
