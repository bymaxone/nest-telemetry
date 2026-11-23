/**
 * @fileoverview Checks the kind of a start option and refuses one of the wrong kind with an error
 * that names the option and never repeats its value.
 * @layer sdk
 */

import { types } from 'node:util'

import {
  apply,
  create,
  entries,
  endsWith,
  getPrototypeOf,
  hasOwn,
  isArray,
  isInteger,
  isProxy,
  isRegExp,
  keys,
  rootPrototype,
  toNumber,
  toText
} from './primordials'

/** The kinds that Node tells apart and that never hold the settings of a host. */
const BRANDS = [
  types.isAnyArrayBuffer,
  types.isArgumentsObject,
  types.isBoxedPrimitive,
  types.isDataView,
  types.isDate,
  types.isGeneratorObject,
  types.isMap,
  types.isMapIterator,
  types.isNativeError,
  types.isPromise,
  types.isRegExp,
  types.isSet,
  types.isSetIterator,
  types.isTypedArray,
  types.isWeakMap,
  types.isWeakSet
]

/**
 * Whether a key is an index of an array: a canonical unsigned 32-bit number below 4294967295, as
 * opposed to a property the host's class added.
 *
 * @param key - An own key of a list.
 * @returns `true` for `'0'` up to `'4294967294'`.
 */
const isIndex = (key: string): boolean =>
  toText(toNumber(key) >>> 0) === key && key !== '4294967295'

/**
 * Whether a list holds an own key that is an index, by index of the key list.
 *
 * @param list - The host's list.
 * @returns `true` when one own key is an index.
 */
function hasIndexKey(list: object): boolean {
  const own = keys(list)
  // Stryker disable next-line EqualityOperator: one step past the end reads `undefined`, which `isIndex` rejects, so the result is the same
  for (let at = 0; at < own.length; at += 1) {
    if (isIndex(own[at] as string)) return true
  }
  return false
}

/** The most entries a list or a map option may hold. */
export const MAX_OPTION_ENTRIES = 1000

/** The error a start rejects with when an option has the wrong kind. */
export class TelemetryOptionError extends Error {
  /** The stable code of this error. */
  readonly code = 'BYMAX_TELEMETRY_OPTION_INVALID'
  /** The option that was refused, as the host wrote it. */
  readonly option: string

  /**
   * @param option - The option that was refused.
   * @param expected - What the option must be.
   * @param cause - The error of the host's own value that made the option unusable.
   */
  constructor(option: string, expected: string, cause?: unknown) {
    super(
      `The ${option} option must be ${expected}, so the start was refused.`,
      cause === undefined ? undefined : { cause }
    )
    this.name = 'TelemetryOptionError'
    this.option = option
  }
}

/**
 * Whether an option was given: `undefined` and `null` are the same as no key.
 *
 * @param value - The option value.
 * @returns `false` for `undefined` and `null`.
 */
export function isGiven<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null
}

/**
 * @param option - The option name, for the error.
 * @param value - The option value.
 * @returns The value, or `undefined` when it is absent.
 * @throws {TelemetryOptionError} When the value is given and is not a boolean.
 */
export function requireBoolean(option: string, value: unknown): boolean | undefined {
  if (!isGiven(value)) return undefined
  if (typeof value !== 'boolean') throw new TelemetryOptionError(option, 'a boolean')
  return value
}

/**
 * @param option - The option name, for the error.
 * @param value - The option value.
 * @returns The value, or `undefined` when it is absent.
 * @throws {TelemetryOptionError} When the value is given and is not a string.
 */
export function requireString(option: string, value: unknown): string | undefined {
  if (!isGiven(value)) return undefined
  if (typeof value !== 'string') throw new TelemetryOptionError(option, 'a string')
  return value
}

/**
 * @param option - The option name, for the error.
 * @param value - The option value.
 * @returns The value, or `undefined` when it is absent.
 * @throws {TelemetryOptionError} When the value is given and is not a function.
 */
export function requireFunction<F extends (...args: never[]) => unknown>(
  option: string,
  value: unknown
): F | undefined {
  if (!isGiven(value)) return undefined
  if (typeof value !== 'function') throw new TelemetryOptionError(option, 'a function')
  return value as F
}

/**
 * @param option - The option name, for the error.
 * @param value - The option value.
 * @returns The value, or `undefined` when it is absent.
 * @throws {TelemetryOptionError} When the value is given and is not an object that is not an array.
 */
export function requireObject(option: string, value: unknown): object | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || isArray(value) || !isSettingsObject(value)) {
    throw new TelemetryOptionError(option, 'an object')
  }
  return value
}

/** The longest chain of prototypes that is followed; a longer one is not an object of settings. */
const MAX_CHAIN = 100

/**
 * Whether an object can be the host's options: not an exotic object of a kind Node reports, and a
 * chain of prototypes that ends within {@link MAX_CHAIN} prototypes, so a plain object, a class
 * instance and the environment object pass and a stand-in whose chain never ends does not. No
 * property of any prototype is read.
 *
 * @param value - An object that is not an array.
 * @returns `true` for an object that can hold settings.
 */
function isSettingsObject(value: object): boolean {
  // By index: a method of the array prototype is not looked up.
  for (let at = 0; at < BRANDS.length; at += 1) {
    if ((BRANDS[at] as (value: unknown) => boolean)(value)) return false
  }
  let next: object | null = getPrototypeOf(value)
  for (let hops = 0; next !== null; hops++) {
    if (hops >= MAX_CHAIN) return false
    next = getPrototypeOf(next)
  }
  return true
}

/**
 * Reads one option of a group from the object the host passed, as the host wrote it: an own field, or a
 * field or getter of a class, but never a value that only the end of its chain of prototypes holds, which a
 * polluted realm could have put there to switch a protection off.
 *
 * @param group - The object the host passed, or `undefined`. A Proxy is read through what it answers.
 * @param name - The option name.
 * @param option - The option as the error names it, `name` by default.
 * @returns The value, read once, or `undefined` when only the root prototype of this realm has it.
 * @throws {TelemetryOptionError} When only a prototype with no prototype, other than the root of this realm, has it.
 */
export function readOwnOrClass(
  group: object | undefined,
  name: string,
  option: string = name
): unknown {
  if (group === undefined) return undefined
  // A Proxy answers for itself, so what it answers is what the host wrote, whichever traps it has.
  if (isProxy(group)) return (group as Record<string, unknown>)[name]
  let holder: object | null = group
  for (let hops = 0; holder !== null && !hasOwn(holder, name); hops++) {
    if (hops >= MAX_CHAIN) return undefined
    holder = getPrototypeOf(holder)
  }
  if (holder === null) return undefined
  if (holder !== group && getPrototypeOf(holder) === null) {
    // The root prototype of this realm is where a pollution is planted, and it is ignored. Any other
    // prototype with no prototype of its own is the host's, so its value is not dropped in silence.
    if (holder === rootPrototype) return undefined
    throw new TelemetryOptionError(
      option,
      'set on the options object itself or on a class, not on a prototype that has no prototype'
    )
  }
  return (group as Record<string, unknown>)[name]
}

/**
 * Copies a list by index, reading its length once as a bounded integer and each index once, never
 * through the iterator or a method of the host's array.
 *
 * @param option - The option name, for the error.
 * @param value - The option value.
 * @param noun - What the entries are, in the plural, for the words of the error.
 * @param take - Returns the copy of an entry, or `undefined` when the entry has the wrong kind.
 * @param guarded - Whether an error the host's own list raises becomes the cause of the library's error.
 * @returns The copies, or `undefined` when the option is absent.
 * @throws {TelemetryOptionError} When the value is not an array of at most {@link MAX_OPTION_ENTRIES}
 *   entries of the right kind, or its length reads empty while it holds entries.
 */
function copyByIndex<T>(
  option: string,
  value: unknown,
  noun: string,
  take: (entry: unknown) => T | undefined,
  guarded: boolean
): readonly T[] | undefined {
  if (!isGiven(value)) return undefined
  const expected = `an array of ${noun}`
  // An error raised by the host's own list is a host error: it is the cause of the library's error
  // when the caller asks for that, and it reaches the caller as it was thrown otherwise.
  const host = <R>(read: () => R): R => {
    if (!guarded) return read()
    try {
      return read()
    } catch (cause) {
      throw new TelemetryOptionError(option, expected, cause)
    }
  }
  if (!host(() => isArray(value))) throw new TelemetryOptionError(option, expected)
  const list = value as unknown[]
  const length: unknown = host(() => list.length)
  if (typeof length !== 'number' || !isInteger(length) || length < 0) {
    throw new TelemetryOptionError(option, expected)
  }
  if (length > MAX_OPTION_ENTRIES) {
    throw new TelemetryOptionError(option, `an array of at most ${MAX_OPTION_ENTRIES} ${noun}`)
  }
  if (length === 0 && host(() => hasIndexKey(list))) {
    throw new TelemetryOptionError(option, expected)
  }
  const copy: T[] = []
  for (let index = 0; index < length; index++) {
    // An own index only: a hole in the host's list is not whatever a prototype holds at that index.
    const taken = take(host(() => (hasOwn(list, index) ? list[index] : undefined)))
    if (taken === undefined) throw new TelemetryOptionError(option, expected)
    copy[copy.length] = taken
  }
  return copy
}

/**
 * Copies a list of strings.
 *
 * @param option - The option name, for the error.
 * @param value - The option value.
 * @returns The strings, or `undefined` when the option is absent.
 * @throws {TelemetryOptionError} When the value is not an array of at most
 *   {@link MAX_OPTION_ENTRIES} strings.
 */
export function settleStringList(option: string, value: unknown): readonly string[] | undefined {
  return copyByIndex(
    option,
    value,
    'strings',
    (entry) => (typeof entry === 'string' ? entry : undefined),
    false
  )
}

/**
 * Copies a list of regular expressions, reading the source and the flags of each once. An error the
 * host's own list raises is the cause of the library's error.
 *
 * @param option - The option name, for the error.
 * @param value - The option value.
 * @returns A new expression for each entry, or `undefined` when the option is absent.
 * @throws {TelemetryOptionError} When the value is not an array of at most
 *   {@link MAX_OPTION_ENTRIES} regular expressions.
 */
export function settleRegExpList(option: string, value: unknown): readonly RegExp[] | undefined {
  return copyByIndex(
    option,
    value,
    'regular expressions',
    (entry) => {
      if (!isRegExp(entry)) return undefined
      try {
        const { source, flags } = entry
        return new RegExp(source, flags)
      } catch (cause) {
        throw new TelemetryOptionError(option, 'an array of regular expressions', cause)
      }
    },
    true
  )
}

/** The path an error names for a setting of an override, so the host's own keys never reach it. */
const OVERRIDE_PATH = 'instrumentations.overrides[]'

/**
 * Refuses an own key named `__proto__`, which `JSON.parse` can produce and which an assignment would
 * turn into the prototype of the copy instead of a setting.
 *
 * @param key - A key of the map or of an entry.
 * @throws {TelemetryOptionError} When the key is `__proto__`.
 */
function refuseProtoKey(key: string): void {
  if (key === '__proto__') throw new TelemetryOptionError(OVERRIDE_PATH, 'free of a __proto__ key')
}

/** The deepest a setting of an override may nest, and the most values it may hold in all. */
const MAX_NESTING = 16
const MAX_VALUES = 10_000

/**
 * Copies a setting that the host nests in an override, so an instrumentation that reads a key of it
 * finds only what the host wrote: a plain object of any realm becomes an object with no prototype and a list
 * is copied by own index, each member the same way. Anything else (a function, a class
 * instance, a `Map`, a `Proxy`) is the host's and is passed on as it is.
 *
 * @param value - A setting, or a value inside one.
 * @param seen - Counts the values copied for one setting.
 * @param depth - How deep the value sits.
 * @returns The copy.
 * @throws {TelemetryOptionError} When the setting nests deeper than {@link MAX_NESTING}, holds more than
 *   {@link MAX_VALUES} values, or a list or object holds more than {@link MAX_OPTION_ENTRIES} members.
 */
function detach(value: unknown, seen: { count: number }, depth: number): unknown {
  if (typeof value !== 'object' || value === null || isProxy(value)) return value
  const list = isArray(value)
  // A plain object is one whose prototype is the end of a chain, the root of whatever realm made it,
  // or that has none; no property of the prototype is read to tell.
  const prototype = getPrototypeOf(value) as object | null
  if (!list && prototype !== null && getPrototypeOf(prototype) !== null) return value
  seen.count += 1
  if (depth > MAX_NESTING || seen.count > MAX_VALUES) {
    throw new TelemetryOptionError(OVERRIDE_PATH, 'nested at most 16 levels deep')
  }
  if (list) {
    if (value.length > MAX_OPTION_ENTRIES) {
      throw new TelemetryOptionError(
        OVERRIDE_PATH,
        `a list of at most ${MAX_OPTION_ENTRIES} entries`
      )
    }
    // By own index, in a loop: a hole is a missing member, not whatever a prototype holds at that index,
    // and no helper that probes its argument for an iterator is used on an object the root prototype
    // reaches.
    const length = value.length
    const copy: unknown[] = []
    for (let index = 0; index < length; index++) {
      copy[index] = detach(hasOwn(value, index) ? value[index] : undefined, seen, depth + 1)
    }
    return copy
  }
  const members = entries(value)
  if (members.length > MAX_OPTION_ENTRIES) {
    throw new TelemetryOptionError(
      OVERRIDE_PATH,
      `an object of at most ${MAX_OPTION_ENTRIES} entries`
    )
  }
  const copy = create(null) as Record<string, unknown>
  for (let at = 0; at < members.length; at += 1) {
    const pair = members[at] as [string, unknown]
    const key = pair[0]
    const member = pair[1]
    refuseProtoKey(key)
    copy[key] = detach(member, seen, depth + 1)
  }
  return copy
}

/**
 * Refuses an object whose settings sit on a prototype with no prototype, which a copy of its own keys
 * would drop in silence. The root prototype of this realm is where a pollution is planted and is ignored,
 * as are the methods of a class, which are not enumerable.
 *
 * @param path - What the error names.
 * @param value - The map or the entry the host passed.
 * @throws {TelemetryOptionError} When a prototype with no prototype, other than the root of this realm,
 *   has an enumerable key.
 */
function refuseAncestorKeys(path: string, value: object): void {
  if (isProxy(value)) return
  let holder: object | null = getPrototypeOf(value)
  for (let hops = 0; holder !== null && hops < MAX_CHAIN; hops++) {
    if (getPrototypeOf(holder) === null && holder !== rootPrototype && keys(holder).length > 0) {
      throw new TelemetryOptionError(
        path,
        'set on the object itself, not on a prototype that has no prototype'
      )
    }
    holder = getPrototypeOf(holder)
  }
}

/**
 * Copies one entry of `overrides` into a plain object, reading each own key once. The settings that
 * decide what leaves the host, and the ones that run host code, are checked by kind: the boolean
 * switches `enabled` and `disableLogSending`, the list `redactedQueryParams`, and every hook.
 *
 * @param entry - The configuration of one instrumentation.
 * @returns The copy, without the settings that are absent.
 * @throws {TelemetryOptionError} When a setting that is checked has the wrong kind, or the entry has
 *   more than {@link MAX_OPTION_ENTRIES} settings.
 */
function settleOverrideEntry(entry: object): Record<string, unknown> {
  refuseAncestorKeys(OVERRIDE_PATH, entry)
  const settings = entries(entry)
  if (settings.length > MAX_OPTION_ENTRIES) {
    throw new TelemetryOptionError(
      OVERRIDE_PATH,
      `an object of at most ${MAX_OPTION_ENTRIES} settings`
    )
  }
  const copy: Record<string, unknown> = {}
  for (let at = 0; at < settings.length; at += 1) {
    const pair = settings[at] as [string, unknown]
    const key = pair[0]
    const setting = pair[1]
    refuseProtoKey(key)
    let settled: unknown = setting
    if (key === 'enabled' || key === 'disableLogSending') {
      settled = requireBoolean(`${OVERRIDE_PATH}.${key}`, setting)
    } else if (key === 'redactedQueryParams') {
      settled = settleStringList(`${OVERRIDE_PATH}.${key}`, setting)
    } else if (apply(endsWith, key, ['Hook'])) {
      settled = requireFunction(`${OVERRIDE_PATH}.<a hook>`, setting)
    } else {
      settled = detach(setting, { count: 0 }, 0)
    }
    if (isGiven(settled)) copy[key] = settled
  }
  return copy
}

/**
 * Copies the `overrides` map, reading each entry once and each setting of an entry once.
 *
 * @param option - The option name, for the error.
 * @param value - The option value.
 * @returns The map, without the entries that are absent, or `undefined` when the option is absent.
 * @throws {TelemetryOptionError} When the value is not an object of at most {@link MAX_OPTION_ENTRIES}
 *   entries that are each an object, or an entry has a setting of the wrong kind.
 */
export function settleOverrides(
  option: string,
  value: unknown
): Record<string, Record<string, unknown>> | undefined {
  const map = requireObject(option, value)
  if (map === undefined) return undefined
  refuseAncestorKeys(option, map)
  const pairs = entries(map)
  if (pairs.length > MAX_OPTION_ENTRIES) {
    throw new TelemetryOptionError(option, `an object of at most ${MAX_OPTION_ENTRIES} entries`)
  }
  const copy: Record<string, Record<string, unknown>> = {}
  for (let at = 0; at < pairs.length; at += 1) {
    const pair = pairs[at] as [string, unknown]
    const name = pair[0]
    const entry = pair[1]
    refuseProtoKey(name)
    const config = requireObject(option, entry)
    if (config !== undefined) copy[name] = settleOverrideEntry(config)
  }
  return copy
}
