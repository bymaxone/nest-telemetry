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

/**
 * Copies a map whose values are objects, reading each entry once.
 *
 * @param option - The option name, for the error.
 * @param value - The option value.
 * @returns The map, without the entries that are absent, or `undefined` when the option is absent.
 * @throws {TelemetryOptionError} When the value is not an object of at most {@link MAX_OPTION_ENTRIES}
 *   entries that are each an object.
 */
export function settleObjectMap(
  option: string,
  value: unknown
): Record<string, object> | undefined {
  const map = requireObject(option, value)
  if (map === undefined) return undefined
  const entries = Object.entries(map)
  if (entries.length > MAX_OPTION_ENTRIES) {
    throw new TelemetryOptionError(option, `an object of at most ${MAX_OPTION_ENTRIES} entries`)
  }
  const copy: Record<string, object> = {}
  for (const [name, entry] of entries) {
    const config = requireObject(option, entry)
    if (config !== undefined) copy[name] = config
  }
  return copy
}
