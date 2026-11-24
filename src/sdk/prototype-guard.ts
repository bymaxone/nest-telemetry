/**
 * @fileoverview Counts how far the `Object.prototype` of this realm is from the one a fresh realm has, so
 * telemetry can refuse to start or to export beside a realm that something polluted.
 * @layer sdk
 *
 * Whatever sits on that prototype is inherited by every plain object that a dependency reads a name from,
 * and no option can shadow all of it, so a process that carries a name the engine does not define is not
 * one telemetry can trust with its data. The count is all that is ever reported, never a name or a value.
 */
import {
  arrayPrototype,
  create,
  getOwnPropertyDescriptor,
  getOwnPropertyDescriptors,
  functionPrototype,
  getPrototypeOf,
  hasOwn,
  NativePromise,
  ownKeys,
  promisePrototype,
  rootPrototype,
  runInFreshRealm
} from './primordials'

/** An expression that reads one built-in object in a realm, and the names of it that are compared. */
type GuardedRow = readonly [string, readonly (string | symbol)[]]

/**
 * The built-ins, besides `Object.prototype`, whose named members the SDK calls on a decision path, by a call or by
 * iterating (a `for...of`, a spread, a destructuring and `new Set(list)` reach `Symbol.iterator`, `next` and `add`
 * with no call in the source): each row is an expression that reads the object in a realm, and the names of it that
 * are compared with a fresh realm's. A member that the host replaced after this module loaded is counted like a
 * changed name of the root prototype.
 */
export const GUARDED_BUILTINS: readonly GuardedRow[] = [
  [
    'Array.prototype',
    [
      'filter',
      'find',
      'flatMap',
      'includes',
      'indexOf',
      'map',
      'push',
      'slice',
      'some',
      Symbol.iterator
    ]
  ],
  [
    'String.prototype',
    [
      'codePointAt',
      'includes',
      'indexOf',
      'padStart',
      'replace',
      'slice',
      'split',
      'startsWith',
      'toLowerCase',
      'toString',
      'trim'
    ]
  ],
  ['Map.prototype', ['get', 'has']],
  ['Set.prototype', ['add', 'has', Symbol.iterator]],
  ['RegExp.prototype', ['test']],
  ['Number.prototype', ['toString']],
  ['Array', ['isArray']],
  ['JSON', ['stringify']],
  ['Number', ['isFinite']],
  ['Object', ['assign', 'create', 'entries', 'fromEntries', 'keys', 'setPrototypeOf', 'values']],
  ['Reflect', ['deleteProperty', 'get', 'set']],
  ['Symbol', ['for']],
  ['Object.getPrototypeOf([][Symbol.iterator]())', ['next']],
  ['Object.getPrototypeOf(new Set()[Symbol.iterator]())', ['next']]
]

/** The expression that reads every guarded object of a realm, in the order of {@link GUARDED_BUILTINS}. */
const EXPRESSION = `[${GUARDED_BUILTINS.map(([expression]) => expression).join(', ')}]`

/** The prototypes of the iterators of an array and of a set, read when this module loads: no name reaches them. */
const ARRAY_ITERATOR = getPrototypeOf([][Symbol.iterator]()) as object
const SET_ITERATOR = getPrototypeOf(new Set()[Symbol.iterator]()) as object

/**
 * Reads the guarded objects of this realm, in the order of {@link GUARDED_BUILTINS}, by the names the code that
 * calls them uses, so a global that was replaced is the one that is read.
 *
 * @returns One object per row.
 */
export function readBuiltins(): readonly object[] {
  return [
    Array.prototype,
    String.prototype,
    Map.prototype,
    Set.prototype,
    RegExp.prototype,
    Number.prototype,
    Array,
    JSON,
    Number,
    Object,
    Reflect,
    Symbol,
    ARRAY_ITERATOR,
    SET_ITERATOR
  ]
}

/**
 * The descriptors of the guarded names of each object, by row. A name the object lacks has no entry, and no
 * entry is read through a prototype: the records have none, and the rows are held by index.
 *
 * @param objects - The objects read by {@link EXPRESSION}, in a realm.
 * @returns One record of descriptors per row.
 */
function describeAll(objects: readonly object[]): Record<number, Descriptors> {
  const rows = create(null) as Record<number, Descriptors>
  for (let at = 0; at < GUARDED_BUILTINS.length; at += 1) {
    const names = (GUARDED_BUILTINS[at] as GuardedRow)[1]
    const row = create(null) as Descriptors
    // Stryker disable next-line EqualityOperator: one step past the row reads a name that no guarded object owns, so no descriptor is kept and nothing changes.
    for (let each = 0; each < names.length; each += 1) {
      const name = names[each] as string | symbol
      const descriptor = getOwnPropertyDescriptor(objects[at] as object, name)
      if (descriptor !== undefined) row[name] = descriptor
    }
    rows[at] = row
  }
  return rows
}

/** What a fresh realm holds: the descriptors of its `Object.prototype` and the text of a function. */
interface Pristine {
  readonly descriptors: Readonly<Record<string | symbol, PropertyDescriptor>>
  readonly sourceOf: (value: unknown) => string
  readonly promiseSource: string
  readonly targets: Readonly<Record<number, Descriptors>>
}

/** What the prototype held when this module loaded, so a name swapped for another native function is caught by identity. */
const loaded = getOwnPropertyDescriptors(rootPrototype) as Record<
  string | symbol,
  PropertyDescriptor
>

/**
 * Builds a fresh realm and reads its `Object.prototype` and a reader of function text. The vm module reads
 * its options, microtaskMode, contextCodeGeneration and others, from objects it makes itself, so a name the
 * prototype under test holds can make it throw: the realm is therefore built when this module loads, while the
 * process is normally still clean, and a build that fails is retried at the first use and, if it fails again,
 * leaves the realm unable to be compared, which counts as polluted.
 *
 * @returns The fresh realm's descriptors and text reader, or `undefined` when it could not be built.
 */
function build(): Pristine | undefined {
  try {
    const made = runInFreshRealm(
      '({ descriptors: Object.getOwnPropertyDescriptors(Object.prototype), ' +
        'sourceOf: (value) => Function.prototype.toString.call(value), ' +
        'promiseSource: Function.prototype.toString.call(Promise), ' +
        `objects: ${EXPRESSION} })`
    ) as {
      descriptors: Descriptors
      sourceOf: Pristine['sourceOf']
      promiseSource: string
      objects: readonly object[]
    }
    return {
      descriptors: made.descriptors,
      sourceOf: made.sourceOf,
      promiseSource: made.promiseSource,
      targets: describeAll(made.objects)
    }
  } catch {
    return undefined
  }
}

/** What each guarded built-in held when this module loaded, by row, so a member swapped for another function is caught. */
const loadedRows = describeAll(readBuiltins())

let pristine: Pristine | undefined = build()

/** The flags of a descriptor that make a name easier to change. */
const FLAGS = ['writable', 'configurable'] as const

/** The fields of a descriptor that hold what the name is. */
const CONTENT = ['value', 'get', 'set'] as const

/**
 * A field of a descriptor, as its own property only: a descriptor of this realm inherits from the prototype
 * under test, so a name planted there, an accessor called `get` say, must never run.
 *
 * @param descriptor - A descriptor, or `undefined`.
 * @param key - The field.
 * @returns The own field, or `undefined`.
 */
function field(descriptor: PropertyDescriptor | undefined, key: keyof PropertyDescriptor): unknown {
  return descriptor !== undefined && hasOwn(descriptor, key) ? descriptor[key] : undefined
}

/**
 * Whether a value of `now` is the one of `was`: the same text for a function, else the same value.
 *
 * @param now - A value of this realm.
 * @param was - The value of the fresh realm.
 * @param sourceOf - Reads function text.
 * @returns `true` when they are alike.
 */
function alike(now: unknown, was: unknown, sourceOf: Pristine['sourceOf']): boolean {
  return typeof was === 'function'
    ? typeof now === 'function' && sourceOf(now) === sourceOf(was)
    : now === was
}

/** One name of the current prototype or of the fresh one, as descriptors. */
type Descriptors = Record<string | symbol, PropertyDescriptor>

/**
 * Whether the descriptor of a name here is the descriptor of the same name in the fresh realm, or a tighter one.
 *
 * @param name - The name.
 * @param have - This realm's descriptors.
 * @param want - The fresh realm's descriptors.
 * @param sourceOf - Reads function text.
 * @returns `true` when nothing about the name is looser or different.
 */
function unchanged(
  name: string | symbol,
  have: Descriptors,
  want: Descriptors,
  sourceOf: Pristine['sourceOf'],
  loaded: Descriptors
): boolean {
  // An absent descriptor reads every field as undefined, so a deleted name and a planted one differ at once.
  const now = hasOwn(have, name) ? have[name] : undefined
  const was = hasOwn(want, name) ? want[name] : undefined
  if (field(now, 'enumerable') !== field(was, 'enumerable')) return false
  // Stryker disable next-line EqualityOperator: one step past the table reads a flag named undefined, which a descriptor never owns, so nothing changes.
  for (let at = 0; at < FLAGS.length; at += 1) {
    const flag = FLAGS[at] as (typeof FLAGS)[number]
    // A flag tighter than the engine's, a frozen realm, is safe; a looser one is not.
    if (field(now, flag) === true && field(was, flag) !== true) return false
  }
  const met = hasOwn(loaded, name) ? loaded[name] : undefined
  // Stryker disable next-line EqualityOperator: one step past the table reads a field named undefined, which a descriptor never owns, so nothing changes.
  for (let at = 0; at < CONTENT.length; at += 1) {
    const key = CONTENT[at] as (typeof CONTENT)[number]
    if (!alike(field(now, key), field(was, key), sourceOf)) return false
    // And it is the function this module met, not another native one put in its place.
    if (met !== undefined && field(now, key) !== field(met, key)) return false
  }
  return true
}

/**
 * Counts the names, strings and symbols, of this realm's `Object.prototype` that a fresh realm's does not hold, that it lacks, or
 * that it holds changed: its flags, or a function whose text is not the engine's, or not the one this module met.
 * Everything it calls was read when the module loaded, and it uses no method of a prototype and no iterator.
 *
 * @returns Zero for a clean realm.
 */
export function pollutedNames(): number {
  pristine ??= build()
  if (pristine === undefined) return 1
  const { descriptors, sourceOf } = pristine
  const now = getOwnPropertyDescriptors(rootPrototype) as Descriptors
  // No prototype, for both: a name is looked up as a key and an entry is appended by assignment, and neither may meet
  // a name, or a setter on an index, that a polluted root prototype holds, which an array would inherit.
  const names = create(null) as Record<number, string | symbol>
  let total = 0
  const seen = create(null) as Record<string | symbol, true | undefined>
  const here = ownKeys(now)
  for (let at = 0; at < here.length; at += 1) {
    const name = here[at] as string | symbol
    // A symbol counts when it is enumerable, as an assignment through a polluted path plants it; a symbol made
    // with defineProperty and hidden needs code that already runs in the process, and a test runner adds one.
    if (typeof name === 'string' || field(now[name], 'enumerable') === true) {
      seen[name] = true
      names[total] = name
      total += 1
    }
  }
  const fresh = ownKeys(descriptors)
  // Stryker disable next-line EqualityOperator: one step past the fresh names looks up a name that is not there, which is the same on both sides, so it is never counted.
  for (let at = 0; at < fresh.length; at += 1) {
    const name = fresh[at] as string | symbol
    if (seen[name] !== true) {
      seen[name] = true
      names[total] = name
      total += 1
    }
  }
  let found = 0
  for (let at = 0; at < total; at += 1) {
    if (!unchanged(names[at] as string | symbol, now, descriptors, sourceOf, loaded)) found += 1
  }
  return (
    found +
    changedBuiltins(pristine.targets, sourceOf) +
    thenOnSiblings() +
    promiseConstructorChanged(pristine)
  )
}

/**
 * Counts the prototypes next to the root that hold a `then`: a value that is an array or a function and is
 * resolved into a promise would be read for it, as an object is read through `Object.prototype`, whose own
 * names are compared above.
 *
 * @returns Zero, one or two.
 */
function thenOnSiblings(): number {
  return (hasOwn(arrayPrototype, 'then') ? 1 : 0) + (hasOwn(functionPrototype, 'then') ? 1 : 0)
}

/**
 * Counts a change of the `constructor` slot of `Promise.prototype`, which every `then` reads for a species: it must
 * still be the data property that holds the engine's own `Promise`. What this module captured is not enough, since a
 * value planted before it loaded would be captured as well; the constructor has to read as the `Promise` of a fresh
 * realm and be the one whose `prototype` is the prototype that was checked.
 *
 * @param fresh - What the fresh realm holds.
 * @returns Zero when untouched, one otherwise.
 */
function promiseConstructorChanged(fresh: Pristine): number {
  const slot = getOwnPropertyDescriptor(promisePrototype, 'constructor')
  const link = getOwnPropertyDescriptor(NativePromise, 'prototype')
  return slot !== undefined &&
    hasOwn(slot, 'value') &&
    slot.value === NativePromise &&
    link !== undefined &&
    hasOwn(link, 'value') &&
    link.value === promisePrototype &&
    fresh.sourceOf(NativePromise) === fresh.promiseSource
    ? 0
    : 1
}

/**
 * Counts the guarded members of the other built-ins that differ from a fresh realm's or from the function this
 * module met: a method of a prototype or a static that something replaced after the library loaded.
 *
 * @param fresh - The fresh realm's descriptors, by row.
 * @param sourceOf - Reads function text.
 * @returns Zero when none changed; one when the built-ins could not be read, which is not clean.
 */
function changedBuiltins(
  fresh: Readonly<Record<number, Descriptors>>,
  sourceOf: Pristine['sourceOf']
): number {
  let found = 0
  try {
    const now = describeAll(readBuiltins())
    for (let at = 0; at < GUARDED_BUILTINS.length; at += 1) {
      const names = (GUARDED_BUILTINS[at] as GuardedRow)[1]
      // Stryker disable next-line EqualityOperator: one step past the row compares a name that neither realm owns, so it is the same on both sides and nothing is counted.
      for (let each = 0; each < names.length; each += 1) {
        const name = names[each] as string | symbol
        const same = unchanged(
          name,
          now[at] as Descriptors,
          fresh[at] as Descriptors,
          sourceOf,
          loadedRows[at] as Descriptors
        )
        if (!same) found += 1
      }
    }
  } catch {
    return 1
  }
  return found
}
