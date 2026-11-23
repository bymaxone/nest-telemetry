/**
 * @fileoverview Reads the source files and pins, both ways, every direct call of a built-in: a static call on a
 * global and a call of a method that a built-in prototype also has. Each is listed with a class, and a call
 * that is new, or a listing whose call is gone, fails.
 * @layer repository
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'

import { GUARDED_BUILTINS } from './sdk/prototype-guard'

type Entry = { count: number; class: 'guarded' | 'captured' | 'inert'; reason?: string }

const ROOT = join(__dirname)
const INVENTORY = JSON.parse(
  readFileSync(join(__dirname, '..', 'scripts', 'builtin-calls.inventory.json'), 'utf8')
) as Record<string, Entry>

/** The globals whose static functions the sources may call. */
const GLOBALS = [
  'Object',
  'Array',
  'JSON',
  'Math',
  'Reflect',
  'String',
  'Number',
  'Symbol',
  'Promise',
  'Date',
  'Error',
  'Buffer',
  'process',
  'Intl',
  'BigInt',
  'Atomics'
]

/** The names that the prototypes of the built-ins hold: a call of one of them may reach a built-in. */
const METHOD_NAMES = new Set(
  [
    Object.prototype,
    Function.prototype,
    Array.prototype,
    String.prototype,
    RegExp.prototype,
    Map.prototype,
    Set.prototype,
    Promise.prototype,
    Number.prototype,
    Error.prototype,
    Object.getPrototypeOf(Uint8Array.prototype) as object
  ].flatMap((prototype) => Object.getOwnPropertyNames(prototype))
)

/** Every non-spec TypeScript file under a directory, as paths relative to the source root. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts')
      ? [path]
      : []
  })
}

/** The calls of one file, counted by `kind|name`. */
function callsOf(path: string): Map<string, number> {
  const found = new Map<string, number>()
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression
      const name = node.expression.name.text
      let key: string | undefined
      if (ts.isIdentifier(target) && GLOBALS.includes(target.text))
        key = `static|${target.text}.${name}`
      else if (METHOD_NAMES.has(name)) key = `method|.${name}`
      if (key !== undefined) found.set(key, (found.get(key) ?? 0) + 1)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** What the sources call now, as `file|kind|name` with a count. */
function scanned(): Record<string, number> {
  const all: Record<string, number> = {}
  for (const path of sourceFiles(ROOT)) {
    const file = path.slice(ROOT.length - 3).replace(/\\/g, '/')
    for (const [key, count] of callsOf(path)) all[`${file}|${key}`] = count
  }
  return all
}

/** Whether the guard's table holds a call: a static of that global, or a method of any guarded prototype. */
function inTable(kind: string, name: string): boolean {
  if (kind === 'static') {
    const [owner, member] = name.split('.') as [string, string]
    return GUARDED_BUILTINS.some(
      ([expression, names]) => expression === owner && names.includes(member)
    )
  }
  return GUARDED_BUILTINS.some(([, names]) => names.includes(name.slice(1)))
}

describe('the direct calls of a built-in in the sources', () => {
  it('lists every call, and only the calls that exist, with their counts', () => {
    // Scenario: a call that was added without a listing fails here, and so does a listing whose call is gone:
    // the inventory cannot drift from the code in either direction.
    const now = scanned()
    const counts = Object.fromEntries(
      Object.entries(INVENTORY).map(([key, entry]) => [key, entry.count])
    )
    expect(counts).toEqual(now)
  })

  it('gives every listing a class from the closed set, and the proof its class needs', () => {
    // Scenario: guarded means the name is in the table the guard compares with a fresh realm; captured means the
    // sources read it from primordials; inert needs a reason, since an unverifiable reason is not inert.
    const primordials = readFileSync(join(ROOT, 'sdk', 'primordials.ts'), 'utf8')
    const problems: string[] = []
    for (const [key, entry] of Object.entries(INVENTORY)) {
      const [, kind, name] = key.split('|') as [string, string, string]
      if (entry.class === 'guarded' && !inTable(kind, name))
        problems.push(`${key}: not in the table`)
      else if (entry.class === 'captured' && !primordials.includes(`= ${name}\n`))
        problems.push(`${key}: not read by primordials`)
      else if (entry.class === 'inert' && (entry.reason ?? '').trim().length < 20)
        problems.push(`${key}: no reason`)
      else if (!['guarded', 'captured', 'inert'].includes(entry.class))
        problems.push(`${key}: class`)
    }
    expect(problems).toEqual([])
  })
})
