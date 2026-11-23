/**
 * @fileoverview Describes a failure for a log entry or a process warning without echoing it.
 * @layer sdk
 *
 * The error of an exporter, an SDK or a loader can quote its configuration, an endpoint with
 * credentials or a header among it, in its message and in the first line of its stack. Library text
 * therefore never includes either: a failure is named by a short code and, for a start that failed
 * for want of a package, by the OpenTelemetry package the message names.
 */
import { apply, reflectGet, regExpExec, toObject, toText } from './primordials'

/** What a code may look like to be named: an upper-case token, never free text. */
const CODE_TOKEN = /^[A-Z0-9_]{1,40}$/

/** The package of the OpenTelemetry scope a failed start can name, the one fact a reader needs. */
const PACKAGE = /@opentelemetry\/[a-z0-9-]+/

/**
 * Reads a short code from an error, or `UNKNOWN`. Only a string or a number is read, because
 * converting an object runs its own `toString`, which can throw; the message and the stack are
 * never read.
 *
 * @param error - The failure, of any type.
 * @returns The code, an upper-case token of 1 to 40 characters, or `UNKNOWN`.
 */
export function codeOf(error: unknown): string {
  try {
    const code: unknown = reflectGet(toObject(error), 'code')
    if (typeof code !== 'string' && typeof code !== 'number') return 'UNKNOWN'
    const text = toText(code)
    return apply(regExpExec, CODE_TOKEN, [text]) ? text : 'UNKNOWN'
  } catch {
    return 'UNKNOWN'
  }
}

/**
 * Describes a failure as its code and, when its message names one, the OpenTelemetry package.
 *
 * @param error - The failure, of any type.
 * @returns Text such as `code ERR_MODULE_NOT_FOUND, package @opentelemetry/sdk-node`.
 */
export function describeFailure(error: unknown): string {
  const code = `code ${codeOf(error)}`
  try {
    const message: unknown = reflectGet(toObject(error), 'message')
    const named =
      typeof message === 'string' ? apply(regExpExec, PACKAGE, [message])?.[0] : undefined
    return named === undefined ? code : `${code}, package ${named}`
  } catch {
    return code
  }
}
