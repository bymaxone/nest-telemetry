/**
 * @fileoverview Pins, both ways, every place on the decision paths that waits for a promise: an `await`, a call of
 * a `Promise` static, a call of `then`, `catch` or `finally`, and an `async` function. A decision that waits is
 * exposed to a `then` that a root prototype holds, to a static that something replaced and to a constructor that is
 * read for a species, so the paths that decide what is exported or started wait through a native promise of the
 * guard's own, and every other wait is listed here with the reason it decides nothing.
 * @layer repository
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'

type Exemption = { file: string; text: string; reason: string }

/** The files whose waits are decisions: what is exported, and what a start builds. */
const DECISION_FILES = ['sdk/start.ts', 'sdk/export-guard.ts'] as const

/** The waits that are allowed, each with the reason it is not a decision. */
const EXEMPT: readonly Exemption[] = [
  {
    file: 'sdk/start.ts',
    text: 'async startTelemetry',
    reason:
      'It hands the handle to the host and decides nothing: the packages are loaded by a callback, not awaited.'
  },
  {
    file: 'sdk/start.ts',
    text: 'await Promise.allSettled([running.shutdown()])',
    reason:
      'A start that arrives during a flush waits for the flush to end; no export or build is decided by its outcome.'
  },
  {
    file: 'sdk/start.ts',
    text: 'Promise.allSettled(…)',
    reason:
      'The same wait: it only sequences a start behind the flush that is running, and its result is not read.'
  },
  {
    file: 'sdk/start.ts',
    text: 'boot(settled, env).finally(…)',
    reason:
      'It clears the record of a start in flight, and the handle it returns is what the boot settled, not a verdict.'
  },
  {
    file: 'sdk/start.ts',
    text: 'Promise.resolve(…)',
    reason:
      'The shutdown of a handle that started nothing: an already resolved promise for the host.'
  }
]

const ROOT = join(__dirname)

/** The waits of one file: the source text of each node that waits, or a short form for a long function. */
function waitsOf(file: string): string[] {
  const path = join(ROOT, file)
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) found.push(node.getText(source))
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ((ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'Promise') ||
        ['then', 'catch', 'finally'].includes(node.expression.name.text))
    )
      found.push(`${node.expression.getText(source)}(…)`)
    else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node)) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true
    )
      found.push(`async ${node.name?.getText(source) ?? '<anonymous>'}`)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('the waits on the decision paths', () => {
  it('lists every wait, and only the waits that exist', () => {
    // Scenario: an await, a Promise static, a then or an async function that was added to a decision file
    // without a listing fails here, and so does a listing whose wait is gone.
    const now = DECISION_FILES.flatMap((file) => waitsOf(file).map((text) => `${file}|${text}`))
    const listed = EXEMPT.map((entry) => `${entry.file}|${entry.text}`)
    expect(now.sort()).toEqual(listed.sort())
  })

  it('gives every listing a reason that says it decides nothing', () => {
    // Scenario: a wait with no reason, or a reason that is only a word, is an unverifiable exemption.
    expect(EXEMPT.filter((entry) => entry.reason.trim().length < 30)).toEqual([])
  })
})
