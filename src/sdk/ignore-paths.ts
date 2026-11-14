/**
 * @fileoverview Path-based predicate for incoming requests that must produce no span.
 * @layer sdk
 */
import type { IncomingRequestTarget } from './types'

/** The longest path the patterns are tested against; a longer one is never ignored. */
const MAX_PATH_LENGTH = 2048

/**
 * Builds a predicate that matches the path of an incoming request against the patterns.
 *
 * Only the path is compared: the query string is cut first, so an exclusion cannot be switched off
 * by appending a parameter, and a probe path hidden in a query cannot trigger one. A request with no
 * target is not matched: failing open costs a span nobody wanted, where the opposite silently drops
 * the traffic least likely to be well formed. A path longer than 2,048 characters is never ignored
 * and the patterns are not run against it, which bounds the work a long path can cause. Anchor
 * the patterns at both ends and give them no nested quantifiers such as `(a+)+`: an unanchored
 * pattern also matches routes that merely contain the word, and the cap does not bound a nested
 * quantifier on a short path: `/^\/(a+)+$/` took 2.5 s and 5.5 s in two runs on 28 characters,
 * and the time grows exponentially with the length.
 *
 * @param patterns - Patterns tested against the path alone.
 * @returns A predicate for `TelemetryOptions.ignoreIncomingRequest`.
 */
export function ignorePaths(
  patterns: readonly RegExp[]
): (request: IncomingRequestTarget) => boolean {
  // Copied without the global and sticky flags: those keep `lastIndex` between tests, so the same
  // path would match on one call and not the next.
  const stateless = patterns.map(
    (pattern) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''))
  )
  return (request) => {
    if (request.url === undefined) {
      return false
    }
    const cut = request.url.indexOf('?')
    const path = cut === -1 ? request.url : request.url.slice(0, cut)
    return path.length <= MAX_PATH_LENGTH && stateless.some((pattern) => pattern.test(path))
  }
}
