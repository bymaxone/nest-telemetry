/**
 * @fileoverview Reads the source files and pins, both ways, every direct call of a built-in (a static call on a
 * global, a call of a method that a built-in prototype also has) and every place that iterates with no call in the
 * source: a for...of, a spread, a destructuring of an array, new Set or new Map with a list. Each is listed with a
 * class, and one that is new, or a listing whose site is gone, fails.
 * @layer repository
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'

import { GUARDED_BUILTINS } from './sdk/prototype-guard'

type Entry = {
  count: number
  class: 'guarded' | 'captured' | 'inert'
  reason?: string
  iterates?: string[]
}

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

/** What each kind of iteration reaches, as members of the guard's table: the object and the name. */
const ITERATES: Record<string, readonly (readonly [string, string | symbol])[]> = {
  array: [
    ['Array.prototype', Symbol.iterator],
    ['Object.getPrototypeOf([][Symbol.iterator]())', 'next']
  ],
  set: [
    ['Set.prototype', Symbol.iterator],
    ['Object.getPrototypeOf(new Set()[Symbol.iterator]())', 'next']
  ],
  add: [['Set.prototype', 'add']]
}

/** The calls that read a list with an iterator of their own. */
const ITERATING_CALLS = ['static|Object.fromEntries']

/** The constructors that read a list with an iterator when given one. */
const COLLECTIONS = ['Set', 'Map', 'WeakSet', 'WeakMap']

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
    let site: string | undefined
    if (ts.isForOfStatement(node)) site = 'for-of'
    else if (ts.isSpreadElement(node)) site = 'spread'
    else if (ts.isArrayBindingPattern(node)) site = 'array-destructure'
    else if (ts.isYieldExpression(node) && node.asteriskToken !== undefined) site = 'yield*'
    else if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      COLLECTIONS.includes(node.expression.text) &&
      (node.arguments?.length ?? 0) > 0
    )
      site = `new-${node.expression.text}`
    if (site !== undefined) {
      const key = `iterate|${site}`
      found.set(key, (found.get(key) ?? 0) + 1)
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

/**
 * Whether the guard's table holds a call: a static of that global, or a method of any guarded prototype. An
 * iteration is not a call; the members it reaches are proved by their own test below.
 */
function inTable(kind: string, name: string): boolean {
  if (kind === 'iterate') return true
  if (kind === 'static') {
    const [owner, member] = name.split('.') as [string, string]
    return GUARDED_BUILTINS.some(
      ([expression, names]) => expression === owner && names.includes(member)
    )
  }
  return GUARDED_BUILTINS.some(([, names]) => names.includes(name.slice(1)))
}

/** Whether the table holds a member: the object, by its expression, and the name. */
function tableHas(expression: string, name: string | symbol): boolean {
  return GUARDED_BUILTINS.some(([row, names]) => row === expression && names.includes(name))
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

  it('names, for each place that iterates, the members of the table it reaches, and each is there', () => {
    // Scenario: a for...of, a spread, a destructuring or new Set(list) reaches Symbol.iterator, next and add with
    // no call in the source; a listing of one must say which kind of list it reads, and every member that kind
    // reaches must be in the table the guard compares with a fresh realm, or a replaced one would go unseen.
    const problems: string[] = []
    for (const [key, entry] of Object.entries(INVENTORY)) {
      const [, kind, name] = key.split('|') as [string, string, string]
      const iterating = kind === 'iterate' || ITERATING_CALLS.includes(`${kind}|${name}`)
      if (!iterating) continue
      if (entry.class !== 'guarded' && entry.class !== 'inert') problems.push(`${key}: class`)
      if (entry.class !== 'guarded') continue
      if ((entry.iterates ?? []).length === 0) problems.push(`${key}: no iterates`)
      for (const list of entry.iterates ?? []) {
        const members = ITERATES[list]
        if (members === undefined) problems.push(`${key}: unknown list ${list}`)
        else
          for (const [expression, member] of members)
            if (!tableHas(expression, member))
              problems.push(`${key}: ${expression} ${String(member)} not in the table`)
      }
    }
    expect(problems).toEqual([])
  })

  it('references every member of the table from a guarded call or a guarded iteration', () => {
    // Scenario: a member nothing reaches only costs bytes and a refusal; every one is reached by a call that is
    // listed as guarded, or by an iteration that names the list it reads.
    const reached = new Set<string>()
    for (const [key, entry] of Object.entries(INVENTORY)) {
      if (entry.class !== 'guarded') continue
      const [, kind, name] = key.split('|') as [string, string, string]
      for (const list of entry.iterates ?? [])
        for (const [expression, member] of ITERATES[list] ?? [])
          reached.add(`${expression}|${String(member)}`)
      if (kind === 'static') {
        const [owner, member] = name.split('.') as [string, string]
        reached.add(`${owner}|${member}`)
      } else if (kind === 'method')
        for (const [expression, names] of GUARDED_BUILTINS)
          if (names.includes(name.slice(1))) reached.add(`${expression}|${name.slice(1)}`)
    }
    const unreached = GUARDED_BUILTINS.flatMap(([expression, names]) =>
      names.map((member) => `${expression}|${String(member)}`).filter((ref) => !reached.has(ref))
    )
    expect(unreached).toEqual([])
  })
})
