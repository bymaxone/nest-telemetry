/**
 * @fileoverview Tests for the spec-header gate: it exits non-zero and names the file for a spec with no
 * header, no layer, a layer outside the list or no stated purpose, and passes a correct one.
 * @layer scripts
 *
 * A gate that never fails proves nothing, so each case runs the real command against a throwaway tree
 * and reads its exit status and its output.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-spec-headers.mjs')
const roots = []

/**
 * Runs the gate over a temporary repository holding `files`.
 *
 * @param {Record<string, string>} files Relative path to file text.
 * @returns {{ status: number | null, output: string }} The command's exit status and combined output.
 */
function run(files) {
  const root = mkdtempSync(join(tmpdir(), 'spec-headers-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const GOOD = `/**
 * @fileoverview Unit tests for the environment reader: which variable decides which option.
 * @layer sdk
 */
describe('x', () => {})
`

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('the spec-header gate', () => {
  it('passes a spec that states its purpose and a known layer', () => {
    // Scenario: one spec with a complete header.
    const { status, output } = run({ 'src/sdk/a.spec.ts': GOOD })
    assert.equal(status, 0, output)
  })

  it('accepts the `Layer: x.` spelling as well as the tag', () => {
    // Scenario: the same header with the sentence form of the layer marker.
    const text = GOOD.replace(' * @layer sdk', ' * Layer: sdk.')
    assert.equal(run({ 'src/sdk/a.spec.ts': text }).status, 0)
  })

  it('reads a layer that contains a digit whole', () => {
    // Scenario: `e2e` is a layer; a marker pattern that stopped at the digit would read it as `e`.
    const text = GOOD.replace('@layer sdk', '@layer e2e')
    assert.equal(run({ 'test/e2e/a.e2e-spec.ts': text }).status, 0)
  })

  it('fails and names a spec with no header', () => {
    // Scenario: a spec that opens with a statement.
    const { status, output } = run({ 'src/sdk/a.spec.ts': GOOD, 'src/sdk/b.spec.ts': 'it()\n' })
    assert.equal(status, 1)
    assert.match(output, /src\/sdk\/b\.spec\.ts: does not open with a \/\*\* \*\/ block comment/)
    assert.doesNotMatch(output, /a\.spec\.ts:/)
  })

  it('fails a comment that opens the file only after a statement', () => {
    // Scenario: the header sits below an import, where a reader scanning the top never sees it.
    const text = `import 'x'\n${GOOD}`
    const { status, output } = run({ 'src/sdk/a.spec.ts': text })
    assert.equal(status, 1)
    assert.match(output, /does not open with a/)
  })

  it('fails a header with no layer marker', () => {
    // Scenario: a purpose and no layer.
    const text = GOOD.replace(' * @layer sdk\n', '')
    const { status, output } = run({ 'src/sdk/a.spec.ts': text })
    assert.equal(status, 1)
    assert.match(output, /no layer marker/)
  })

  it('fails a layer outside the list', () => {
    // Scenario: a layer the package does not have.
    const { status, output } = run({ 'src/sdk/a.spec.ts': GOOD.replace('@layer sdk', '@layer ui') })
    assert.equal(status, 1)
    assert.match(output, /names the layer "ui"/)
  })

  it('fails a header that is only a layer', () => {
    // Scenario: the marker with nothing that says what the file tests.
    const text = '/**\n * @layer sdk\n */\nit()\n'
    const { status, output } = run({ 'src/sdk/a.spec.ts': text })
    assert.equal(status, 1)
    assert.match(output, /not what the file tests/)
  })

  it('checks the end-to-end suite under test as well as src', () => {
    // Scenario: a bad e2e spec beside a good unit spec.
    const { status, output } = run({
      'src/sdk/a.spec.ts': GOOD,
      'test/e2e/b.e2e-spec.ts': 'it()\n'
    })
    assert.equal(status, 1)
    assert.match(output, /test\/e2e\/b\.e2e-spec\.ts/)
  })

  it('fails when there is no spec to check', () => {
    // Scenario: a tree with sources and no spec, which would otherwise pass on nothing.
    const { status, output } = run({ 'src/sdk/a.ts': 'export {}\n' })
    assert.equal(status, 1)
    assert.match(output, /No spec file found/)
  })
})
