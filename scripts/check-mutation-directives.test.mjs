/**
 * @fileoverview Tests for the mutation-directive gate: it fails when it cannot read the mutator
 * names from Stryker, instead of passing with the name check left out.
 * @layer scripts
 *
 * The gate is run as a command against a throwaway tree, so its exit status is what is asserted.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-mutation-directives.mjs')
const roots = []

/**
 * Runs a copy of the gate from a tree with no `node_modules`, so Stryker cannot be resolved.
 *
 * @param {string} source Text of the one source file under `src/`.
 * @returns {{ status: number | null, output: string }} The command's exit status and combined output.
 */
function runWithoutStryker(source) {
  const root = mkdtempSync(join(tmpdir(), 'mutation-directives-'))
  roots.push(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'src', 'a.ts'), source)
  const copy = join(root, 'scripts', 'check-mutation-directives.mjs')
  copyFileSync(SCRIPT, copy)
  const result = spawnSync(process.execPath, [copy], { cwd: root, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('check-mutation-directives', () => {
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
  })

  // A directive naming a mutator that does not exist silences nothing. Without the names the gate
  // cannot tell, so it must fail rather than report that every directive parses.
  it('fails when the mutator names cannot be loaded', () => {
    const { status, output } = runWithoutStryker(
      '// Stryker disable next-line NoSuchMutator: reason\nexport const a = 1\n'
    )

    assert.equal(status, 1, output)
    assert.match(output, /mutator names unavailable/)
    assert.doesNotMatch(output, /All Stryker directives parse/)
  })
})
