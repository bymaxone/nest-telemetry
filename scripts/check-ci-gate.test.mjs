/**
 * @fileoverview Tests the aggregate job of the CI workflow, the single check a merge can require:
 * it runs the job's own shell script against dependency results. A job with no condition of its own
 * must have succeeded; only `security`, which is conditional, may be skipped.
 * @layer scripts
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
const JOB = WORKFLOW.split('\n  ci-pass:\n')[1] ?? ''

/** The jobs the aggregate waits for. */
const NEEDS = (/\n {4}needs: \[([^\]]+)\]\n/.exec(JOB)?.[1] ?? '').split(',').map((n) => n.trim())

/** The shell script of the aggregate's last step: the one that decides. */
function script() {
  const body = JOB.split('\n        run: |\n').at(-1)
  assert.ok(body, 'the aggregate ends in a script')
  return body.replace(/^ {10}/gm, '')
}

/** The variable of the last step that receives each job's result. */
function variables() {
  const pairs = [...JOB.matchAll(/\n {10}([A-Z_]+): \$\{\{ needs\.([a-z-]+)\.result \}\}/g)]
  return new Map(pairs.map((pair) => [pair[2], pair[1]]))
}

/** The exit status of the deciding script for the given results; every other job succeeded. */
function decide(results) {
  const env = { PATH: process.env.PATH }
  for (const [job, name] of variables()) env[name] = results[job] ?? 'success'
  return spawnSync('bash', ['-e', '-c', script()], { env }).status
}

describe('CI aggregate', () => {
  // A job added to `needs` without a result variable would be waited for and never judged.
  it('reads the result of every job it needs', () => {
    assert.ok(NEEDS.length > 1, 'the needs list was found')
    assert.deepEqual([...variables().keys()].sort(), [...NEEDS].sort())
  })

  // The ordinary green run, with and without the conditional job.
  it('passes when every job succeeded, or only security was skipped', () => {
    assert.equal(decide({}), 0)
    assert.equal(decide({ security: 'skipped' }), 0)
  })

  // A skip of an unconditional job means the graph is broken, and a skip reports success.
  it('fails on any other result', () => {
    for (const job of NEEDS) {
      for (const result of ['failure', 'cancelled', 'skipped']) {
        if (job === 'security' && result === 'skipped') continue
        assert.notEqual(decide({ [job]: result }), 0, `${job} ${result}`)
      }
    }
  })
})
