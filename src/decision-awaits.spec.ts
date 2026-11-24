/**
 * @fileoverview Pins, both ways, every place on the decision paths that waits for a promise: an `await`, a call of
 * a `Promise` static, a call of `then`, `catch` or `finally`, and an `async` function. A decision that waits is
 * exposed to a `then` that a root prototype holds, to a static that something replaced and to a constructor that is
 * read for a species, so the paths that decide what is exported or started wait through a native promise of the
 * guard's own, and every other wait is listed here with the reason it decides nothing.
 * @layer repository
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'

type Exemption = { file: string; text: string; reason: string }

/**
 * Every source file under `src`, tests excepted: a list of the files that decide proves nothing about the files left
 * out of it, so a file that is added is scanned without anyone listing it.
 *
 * @param dir - A directory under `src`, relative to it.
 * @returns The paths of the source files, relative to `src`.
 */
function sourceFiles(dir = ''): string[] {
  return readdirSync(join(__dirname, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') && !path.endsWith('.d.ts')
      ? [path]
      : []
  })
}

/** The files whose waits are scanned: all of them. */
const DECISION_FILES = sourceFiles()

/** The constructions of a promise that are allowed, each from the captured intrinsic, with a reason. */
const EXEMPT_CONSTRUCTIONS: Exemption[] = []

/** The waits that are allowed, each with the reason it is not a decision. */
const EXEMPT: readonly Exemption[] = [
  {
    file: 'nest/telemetry-shutdown.hook.ts',
    text: 'await shutdownTelemetry()',
    reason:
      "The promise is the library's own, with its own constructor; the outcome only picks a report, no verdict."
  },
  {
    file: 'nest/telemetry-shutdown.hook.ts',
    text: 'async onApplicationShutdown',
    reason: 'Nest awaits the hook while the application closes; it decides nothing about an export.'
  },
  {
    file: 'nest/telemetry-shutdown.hook.ts',
    text: 'Promise.resolve(…)',
    reason:
      'Takes the promise an application logger returned, whose outcome nobody uses for a verdict.'
  },
  {
    file: 'nest/telemetry-shutdown.hook.ts',
    text: 'Promise.resolve(result).catch(…)',
    reason:
      'Only turns a rejected logger entry into a process warning; the outcome decides nothing.'
  },
  {
    file: 'register/boot.ts',
    text: 'Promise.allSettled(…)',
    reason: 'A flush on exit whose outcome is discarded with `void`; nothing is decided by it.'
  },
  {
    file: 'register/boot.ts',
    text: 'async bootFromEnvironment',
    reason: 'Returns the prototype-less handle, which resolves with no `then` to read from a chain.'
  },
  {
    file: 'register/boot.ts',
    text: `await startOrWarn(
    dependencies.start ?? startTelemetry,
    dependencies.env === undefined ? {} : { env: dependencies.env }
  )`,
    reason:
      'A native await of the promise of startOrWarn, which carries its own constructor and is built by this module.'
  },
  {
    file: 'sdk/primordials.ts',
    text: 'async <anonymous>',
    reason: 'Builds the one sample promise the engine intrinsics are read from; it awaits nothing.'
  },
  {
    file: 'sdk/native-promise.ts',
    text: 'await promise',
    reason:
      'A native await of a promise whose constructor is the intrinsic or was tagged: it reads no then and no species.'
  },
  {
    file: 'sdk/native-promise.ts',
    text: 'async settle',
    reason:
      'The one wait of the library, which hands the outcome to a callback and decides nothing by itself.'
  }
]

/** A construction from the promise constructor captured when the library loaded: a swap to the global is caught. */
const captured = (where: string, why: string): Exemption => ({
  file: where.split('|')[0] as string,
  text: `new NativePromise(…) [captured] in ${where.split('|')[1]}`,
  reason: why
})

EXEMPT_CONSTRUCTIONS.push(
  captured(
    'sdk/start.ts|startTelemetry',
    'The promise the call answers with, from the captured intrinsic, settled only after a check of the process.'
  ),
  captured(
    'sdk/start.ts|boot',
    'The promise the boot settles itself, built from the intrinsic captured at load, never from the global binding.'
  ),
  captured(
    'register/boot.ts|startOrWarn',
    'The promise the boot waits on, from the captured intrinsic with its own constructor, so a planted then is never read.'
  ),
  captured(
    'sdk/export-guard.ts|refuseIfPolluted',
    'The promise that answers for a provider: the intrinsic captured at load, settled after a check.'
  ),
  captured(
    'sdk/export-guard.ts|refuseIfPolluted',
    'The adoption of a thenable that is not a promise, so the one that is consumed is a native one.'
  ),
  captured(
    'sdk/export-guard.ts|guardedSend',
    'The promise a guarded send answers with: the intrinsic captured at load, settled after a check.'
  ),
  captured(
    'sdk/native-promise.ts|resolvedPromise',
    'An already fulfilled promise built from the captured intrinsic, so no Promise static is read.'
  ),
  captured(
    'sdk/handle.ts|beginFlush',
    'The promise the flush answers with: the intrinsic captured at load, settled once the SDK stopped or the deadline passed.'
  ),
  captured(
    'sdk/handle.ts|shutdownTelemetry',
    'The promise a caller of the module-level shutdown awaits, from the captured intrinsic and tagged with its own constructor.'
  )
)

const ROOT = join(__dirname)

/** Whether an expression is the global `Promise`, written plainly or as a member of something. */
const isGlobalPromise = (node: ts.Expression): boolean =>
  (ts.isIdentifier(node) && node.text === 'Promise') ||
  (ts.isPropertyAccessExpression(node) && node.name.text === 'Promise')

/** The name of the function a node sits in, so a construction is listed per site. */
function enclosing(node: ts.Node): string {
  for (let up: ts.Node | undefined = node.parent; up !== undefined; up = up.parent) {
    if (ts.isFunctionDeclaration(up) && up.name !== undefined) return up.name.text
  }
  return '<module>'
}

/** `Promise`, and every local name bound to the global one, so `new` on an alias is seen as `new Promise`. */
function promiseAliases(source: ts.SourceFile): Set<string> {
  const aliases = new Set<string>(['Promise'])
  const collect = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isGlobalPromise(node.initializer)
    )
      aliases.add(node.name.text)
    ts.forEachChild(node, collect)
  }
  collect(source)
  return aliases
}

/** What a `new` expression is listed as, or `undefined` when it builds something else. */
function constructionOf(node: ts.NewExpression, aliases: Set<string>): string | undefined {
  if (!ts.isIdentifier(node.expression)) return undefined
  if (aliases.has(node.expression.text)) return `new ${node.expression.text}(…)`
  return node.expression.text === 'NativePromise'
    ? `new NativePromise(…) [captured] in ${enclosing(node)}`
    : undefined
}

/** What any other node that waits is listed as, or `undefined`. */
function waitOf(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isAwaitExpression(node)) return node.getText(source)
  if (ts.isForOfStatement(node) && node.awaitModifier !== undefined) return 'for await'
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ((ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'Promise') ||
      ['then', 'catch', 'finally'].includes(node.expression.name.text))
  )
    return `${node.expression.getText(source)}(…)`
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)) &&
    node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true
  )
    return `async ${node.name?.getText(source) ?? '<anonymous>'}`
  return undefined
}

/** The waits of one file: the source text of each node that waits, or a short form for a long function. */
function waitsOf(file: string): string[] {
  const path = join(ROOT, file)
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const aliases = promiseAliases(source)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    const listed = ts.isNewExpression(node) ? constructionOf(node, aliases) : waitOf(node, source)
    if (listed !== undefined) found.push(listed)
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
    const listed = [...EXEMPT, ...EXEMPT_CONSTRUCTIONS].map(
      (entry) => `${entry.file}|${entry.text}`
    )
    expect(now.sort()).toEqual(listed.sort())
  })

  it('gives every listing a reason that says it decides nothing', () => {
    // Scenario: a wait with no reason, or a reason that is only a word, is an unverifiable exemption.
    expect(
      [...EXEMPT, ...EXEMPT_CONSTRUCTIONS].filter((entry) => entry.reason.trim().length < 30)
    ).toEqual([])
  })
})
