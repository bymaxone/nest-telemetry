/**
 * @fileoverview Counts how far the `Object.prototype` of this realm is from the one a fresh realm has, so
 * telemetry can refuse to start or to export beside a realm that something polluted.
 * @layer sdk
 *
 * Whatever sits on that prototype is inherited by every plain object that a dependency reads a name from,
 * and no option can shadow all of it, so a process that carries a name the engine does not define is not
 * one telemetry can trust with its data. The count is all that is ever reported, never a name or a value.
 */
import { runInNewContext } from 'node:vm'

/** What a fresh realm holds: the descriptors of its `Object.prototype` and the text of a function. */
interface Pristine {
  readonly descriptors: Readonly<Record<string | symbol, PropertyDescriptor>>
  readonly sourceOf: (value: unknown) => string
}

/** What the prototype held when this module loaded, so a name swapped for another native function is caught by identity. */
const loaded = Object.getOwnPropertyDescriptors(Object.prototype) as Record<
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
    return runInNewContext(
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
  return descriptor !== undefined && Object.hasOwn(descriptor, key) ? descriptor[key] : undefined
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

/**
 * Counts the names, strings and symbols, of this realm's `Object.prototype` that a fresh realm's does not hold, that it lacks, or
 * that it holds changed: its flags, or a function whose text is not the engine's, or not the one this module met.
 *
 * @returns Zero for a clean realm.
 */
export function pollutedNames(): number {
  pristine ??= build()
  if (pristine === undefined) return 1
  const { descriptors, sourceOf } = pristine
  const now = Object.getOwnPropertyDescriptors(Object.prototype) as Record<
    string | symbol,
    PropertyDescriptor
  >
  // A symbol counts when it is enumerable, as an assignment through a polluted path plants it; a symbol made
  // with defineProperty and hidden needs code that already runs in the process, and a test runner adds one.
  const names = new Set([
    ...Reflect.ownKeys(now).filter(
      (name) => typeof name === 'string' || field(now[name], 'enumerable') === true
    ),
    ...Reflect.ownKeys(descriptors)
  ])
  let found = 0
  for (const name of names) {
    // An absent descriptor reads every field as undefined, so a deleted name and a planted one differ at once.
    const have = Object.hasOwn(now, name) ? now[name] : undefined
    const want = Object.hasOwn(descriptors, name) ? descriptors[name] : undefined
    const same =
      field(have, 'enumerable') === field(want, 'enumerable') &&
      // A flag tighter than the engine's, a frozen realm, is safe; a looser one is not.
      FLAGS.every((flag) => field(have, flag) !== true || field(want, flag) === true) &&
      CONTENT.every(
        (key) =>
          alike(field(have, key), field(want, key), sourceOf) &&
          // And it is the function this module met, not another native one put in its place.
          (!Object.hasOwn(loaded, name) || field(have, key) === field(loaded[name], key))
      )
    if (!same) found += 1
  }
  return found
}
