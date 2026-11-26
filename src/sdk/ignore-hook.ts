/**
 * @fileoverview The guard around the host's ignore hook: the HTTP instrumentation reads its answer at
 * once, so a promise would be truthy and its rejection would reach nobody.
 * @layer sdk
 */
import { absorbHost, ignore } from './native-promise'
import { apply, isPromise } from './primordials'
import { reportWarning } from './warning-sink'

/**
 * Takes the rejection of an answer that is a promise or another thenable.
 *
 * @param answer - What the hook returned.
 * @returns Whether it was one. Nothing is read from a primitive, so a `then` on a root prototype of
 *   primitives is never found.
 */
function absorbThenable(answer: unknown): boolean {
  if (isPromise(answer)) {
    absorbHost(answer, ignore, ignore)
    return true
  }
  if ((typeof answer !== 'object' || answer === null) && typeof answer !== 'function') return false
  const then = (answer as { readonly then?: unknown }).then
  if (typeof then !== 'function') return false
  try {
    apply(then, answer, [ignore, ignore])
  } catch {
    // A `then` that throws has nothing left to reject.
  }
  return true
}

/**
 * Wraps the host's ignore hook so that only a synchronous answer can ignore a request. A thenable
 * counts as "not ignored", its rejection is taken, and the first one is reported. A synchronous
 * answer is handed over as it is, and a synchronous throw reaches the instrumentation, which catches
 * it.
 *
 * @param hook - The host's hook.
 * @returns The hook the instrumentation is given.
 */
export function guardIgnoreHook<Request>(
  hook: (request: Request) => unknown
): (request: Request) => unknown {
  let reported = false
  return function guarded(this: unknown, request: Request): unknown {
    const answer: unknown = apply(hook, this, [request])
    if (!absorbThenable(answer)) return answer
    if (!reported) {
      reported = true
      reportWarning({
        code: 'BYMAX_TELEMETRY_IGNORE_HOOK_ASYNC',
        text: 'ignoreIncomingRequest returned a promise, so the request is traced. Return true or false synchronously. Warned once.'
      })
    }
    return false
  }
}
