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
  create,
  getOwnPropertyDescriptors,
  hasOwn,
  ownKeys,
  rootPrototype,
  runInFreshRealm
} from './primordials'

/** What a fresh realm holds: the descriptors of its `Object.prototype` and the text of a function. */
interface Pristine {
  readonly descriptors: Readonly<Record<string | symbol, PropertyDescriptor>>
  readonly sourceOf: (value: unknown) => string
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
    return runInFreshRealm(
      '({ descriptors: Object.getOwnPropertyDescriptors(Object.prototype), ' +
        'sourceOf: (value) => Function.prototype.toString.call(value) })'
    ) as Pristine
  } catch {
    return undefined
  }
}

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
  sourceOf: Pristine['sourceOf']
): boolean {
  // An absent descriptor reads every field as undefined, so a deleted name and a planted one differ at once.
  const now = hasOwn(have, name) ? have[name] : undefined
  const was = hasOwn(want, name) ? want[name] : undefined
  if (field(now, 'enumerable') !== field(was, 'enumerable')) return false
  for (let at = 0; at < FLAGS.length; at += 1) {
    const flag = FLAGS[at] as (typeof FLAGS)[number]
    // A flag tighter than the engine's, a frozen realm, is safe; a looser one is not.
    if (field(now, flag) === true && field(was, flag) !== true) return false
  }
  const met = hasOwn(loaded, name) ? loaded[name] : undefined
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
  const names: (string | symbol)[] = []
  // No prototype: a name here is looked up as a key, and must never meet one a polluted root prototype holds.
  const seen = create(null) as Record<string | symbol, true | undefined>
  const here = ownKeys(now)
  for (let at = 0; at < here.length; at += 1) {
    const name = here[at] as string | symbol
    // A symbol counts when it is enumerable, as an assignment through a polluted path plants it; a symbol made
    // with defineProperty and hidden needs code that already runs in the process, and a test runner adds one.
    if (typeof name === 'string' || field(now[name], 'enumerable') === true) {
      seen[name] = true
      names[names.length] = name
    }
  }
  const fresh = ownKeys(descriptors)
  for (let at = 0; at < fresh.length; at += 1) {
    const name = fresh[at] as string | symbol
    if (seen[name] !== true) {
      seen[name] = true
      names[names.length] = name
    }
  }
  let found = 0
  for (let at = 0; at < names.length; at += 1) {
    if (!unchanged(names[at] as string | symbol, now, descriptors, sourceOf)) found += 1
  }
  return found
}
