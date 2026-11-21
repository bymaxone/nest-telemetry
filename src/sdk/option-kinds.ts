/**
 * @fileoverview Checks the kind of a start option and refuses one of the wrong kind with an error
 * that names the option and never repeats its value.
 * @layer sdk
 */

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
   */
  constructor(option: string, expected: string) {
    super(`The ${option} option must be ${expected}, so the start was refused.`)
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
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TelemetryOptionError(option, 'an object')
  }
  return value
}

/**
 * Copies a list of strings, reading its length once and each index once.
 *
 * @param option - The option name, for the error.
 * @param value - The option value.
 * @returns The strings, or `undefined` when the option is absent.
 * @throws {TelemetryOptionError} When the value is not an array of at most
 *   {@link MAX_OPTION_ENTRIES} strings.
 */
export function settleStringList(option: string, value: unknown): readonly string[] | undefined {
  if (!isGiven(value)) return undefined
  if (!Array.isArray(value)) throw new TelemetryOptionError(option, 'an array of strings')
  const length: unknown = value.length
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
    throw new TelemetryOptionError(option, 'an array of strings')
  }
  if (length > MAX_OPTION_ENTRIES) {
    throw new TelemetryOptionError(option, `an array of at most ${MAX_OPTION_ENTRIES} strings`)
  }
  const copy: string[] = []
  for (let index = 0; index < length; index++) {
    const item: unknown = value[index]
    if (typeof item !== 'string') throw new TelemetryOptionError(option, 'an array of strings')
    copy.push(item)
  }
  return copy
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
  const settings = Object.entries(entry)
  if (settings.length > MAX_OPTION_ENTRIES) {
    throw new TelemetryOptionError(
      OVERRIDE_PATH,
      `an object of at most ${MAX_OPTION_ENTRIES} settings`
    )
  }
  const copy: Record<string, unknown> = {}
  for (const [key, setting] of settings) {
    refuseProtoKey(key)
    let settled: unknown = setting
    if (key === 'enabled' || key === 'disableLogSending') {
      settled = requireBoolean(`${OVERRIDE_PATH}.${key}`, setting)
    } else if (key === 'redactedQueryParams') {
      settled = settleStringList(`${OVERRIDE_PATH}.${key}`, setting)
    } else if (key.endsWith('Hook')) {
      settled = requireFunction(`${OVERRIDE_PATH}.<a hook>`, setting)
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
  const entries = Object.entries(map)
  if (entries.length > MAX_OPTION_ENTRIES) {
    throw new TelemetryOptionError(option, `an object of at most ${MAX_OPTION_ENTRIES} entries`)
  }
  const copy: Record<string, Record<string, unknown>> = {}
  for (const [name, entry] of entries) {
    refuseProtoKey(name)
    const config = requireObject(option, entry)
    if (config !== undefined) copy[name] = settleOverrideEntry(config)
  }
  return copy
}
