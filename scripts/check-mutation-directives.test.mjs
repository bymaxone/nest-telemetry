/**
 * Drives `check-mutation-directives.mjs` as a child process over throwaway source trees, and asserts
 * its exit status: the gate has to fail when it cannot check a directive, not only when one is wrong.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./check-mutation-directives.mjs', import.meta.url))
const PACKAGES = fileURLToPath(new URL('../node_modules', import.meta.url))

const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/**
 * A temporary tree whose `src/probe.ts` carries one directive for `mutators`. The script reads the
 * mutator names from the tree it inspects, so `installed` links this repository's packages into it.
 */
function project(mutators, { installed = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mutation-directives-'))
  roots.push(root)
  if (installed) symlinkSync(PACKAGES, join(root, 'node_modules'), 'dir')
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'src', 'probe.ts'),
    `// Stryker disable next-line ${mutators}: a reason\nexport const probe = 1\n`
  )
  return root
}

/** Runs the script with `root` as the working directory. */
function run(root) {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' })
  return { status: result.status, output: result.stdout + result.stderr }
}

test('passes a directive that names a mutator the installed Stryker has', () => {
  const { status, output } = run(project('StringLiteral'))
  assert.equal(status, 0, output)
})

test('fails a directive that names no known mutator, and lists the ones Stryker has', () => {
  const { status, output } = run(project('NoSuchMutator'))
  assert.equal(status, 1)
  assert.match(output, /unknown mutator "NoSuchMutator"/)
  assert.match(output, /Mutators Stryker accepts: .*StringLiteral/)
})

test('fails a mutator list with a dangling comma', () => {
  const { status, output } = run(project('StringLiteral,'))
  assert.equal(status, 1)
  assert.match(output, /empty entry in the mutator list/)
})

test('fails when the mutator names cannot be loaded', () => {
  const { status, output } = run(project('StringLiteral', { installed: false }))
  assert.equal(status, 1, output)
  assert.match(output, /Cannot find module '@stryker-mutator\/core'/)
})
