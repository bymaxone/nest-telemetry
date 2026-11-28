/**
 * @fileoverview Tests that the release jobs block network egress, and that the build job allows every
 * host the README link check requests. A host missing from the list would be blocked, and the check
 * reports a host it cannot reach as a note, so a dead link on it would pass the release unseen.
 * @layer scripts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')

/** The text of one job of the release workflow, up to the next job or the end of the file. */
function job(name) {
  const after = WORKFLOW.split(`\n  ${name}:\n`)[1]
  assert.ok(after, `the release workflow has a ${name} job`)
  return after.split(/\n {2}[a-z-]+:\n/)[0]
}

/** The `allowed-endpoints` entries of one job. */
function allowed(name) {
  const block = /\n( +)allowed-endpoints: >\n((?:\1 {2}\S+\n)+)/.exec(job(name))
  assert.ok(block, `the ${name} job lists its allowed endpoints`)
  return block[2].trim().split(/\s+/)
}

/** The hosts of the links the published-surface check requests, as that check collects them. */
function linkHosts() {
  const prose = README.replace(/^```[\s\S]*?^```$/gm, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  const links = [
    ...prose.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g),
    ...prose.matchAll(/<a\s+href="(https?:\/\/[^"]+)"/g)
  ]
  return [...new Set(links.map((match) => new URL(match[1]).hostname))]
}

describe('release egress', () => {
  // Audit mode reports a connection and lets it through; only block mode stops one.
  it('blocks egress in every job', () => {
    for (const name of ['build', 'publish']) {
      assert.match(job(name), /egress-policy: block\n/, name)
    }
    assert.doesNotMatch(WORKFLOW, /egress-policy: audit/)
  })

  // A README link on a new host needs that host on the list, or the link is no longer checked there.
  it('allows every host the README links to', () => {
    const hosts = linkHosts()
    assert.ok(hosts.length > 5, 'the links were found')
    const list = allowed('build')
    const missing = hosts.filter((host) => !list.includes(`${host}:443`))
    assert.deepEqual(missing, [])
  })
})
