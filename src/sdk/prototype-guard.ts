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
  readonly descriptors: Readonly<Record<string, PropertyDescriptor>>
  readonly sourceOf: (value: unknown) => string
}

/** What the prototype held when this module loaded, so a name swapped for another native function is caught by identity. */
const loaded = Object.getOwnPropertyDescriptors(Object.prototype) as Record<
  string,
  PropertyDescriptor
>

let pristine: Pristine | undefined

/**
 * A fresh realm's `Object.prototype`, read once: nothing a host did to this realm reaches it.
 *
 * @returns The descriptors and a reader of function text from that realm.
 */
function standard(): Pristine {
  pristine ??= runInNewContext(
    '({ descriptors: Object.getOwnPropertyDescriptors(Object.prototype), ' +
      'sourceOf: (value) => Function.prototype.toString.call(value) })'
  ) as Pristine
  return pristine
}

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
 * Counts the names of this realm's `Object.prototype` that a fresh realm's does not hold, that it lacks, or
 * that it holds changed: its flags, or a function whose text is not the engine's, or not the one this module met.
 *
 * @returns Zero for a clean realm.
 */
export function pollutedNames(): number {
  const { descriptors, sourceOf } = standard()
  const now = Object.getOwnPropertyDescriptors(Object.prototype) as Record<
    string,
    PropertyDescriptor
  >
  const names = new Set([
    ...Object.getOwnPropertyNames(now),
    ...Object.getOwnPropertyNames(descriptors)
  ])
  let found = 0
  for (const name of names) {
    const have = Object.hasOwn(now, name) ? now[name] : undefined
    const want = Object.hasOwn(descriptors, name) ? descriptors[name] : undefined
    const same =
      have !== undefined &&
      want !== undefined &&
      field(have, 'enumerable') === field(want, 'enumerable') &&
      // A flag tighter than the engine's, a frozen realm, is safe; a looser one is not.
      !(field(have, 'writable') && !field(want, 'writable')) &&
      !(field(have, 'configurable') && !field(want, 'configurable')) &&
      alike(field(have, 'value'), field(want, 'value'), sourceOf) &&
      alike(field(have, 'get'), field(want, 'get'), sourceOf) &&
      alike(field(have, 'set'), field(want, 'set'), sourceOf) &&
      (!Object.hasOwn(loaded, name) ||
        (field(have, 'value') === field(loaded[name], 'value') &&
          field(have, 'get') === field(loaded[name], 'get') &&
          field(have, 'set') === field(loaded[name], 'set')))
    if (!same) found += 1
  }
  return found
}
