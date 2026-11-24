/**
 * @fileoverview Waits for a promise with a native `await`, without a `then` or a `constructor` that something replaced
 * on `Promise.prototype` deciding what runs.
 * @layer sdk
 *
 * `Promise.prototype.then` reads `constructor` of the promise it is called on, and then `Symbol.species` of that
 * constructor, both of which a host can replace. A native `await` of a promise whose `constructor` is the intrinsic
 * reads neither. A promise this library made gets its own `constructor`, so the lookup ends on it; a promise a host
 * made is never written to, so a failed wait is reported to the caller, which fails closed.
 */
import { POLLUTED_CODE } from './error-code'
import { defineProperty, ErrorClass, NativePromise } from './primordials'

/**
 * Gives a promise this library made an own `constructor`, so that a caller that awaits it, or a `then` called on it,
 * ends the lookup on the intrinsic instead of on a `Promise.prototype.constructor` that something replaced. The
 * property is read-only and not configurable, so the host that receives the promise cannot redefine it. A promise
 * that cannot take the property, a frozen one, is returned as it is.
 *
 * @param promise - A promise the library made, never a host's.
 * @returns The same promise.
 */
export function ownConstructor<T>(promise: Promise<T>): Promise<T> {
  try {
    defineProperty(promise, 'constructor', {
      __proto__: null,
      value: NativePromise
    } as PropertyDescriptor)
  } catch {
    return promise
  }
  return promise
}

/**
 * A promise that is already fulfilled, with an own `constructor`, built without a `Promise` static.
 *
 * @returns A fulfilled promise of the library's own.
 */
export function resolvedPromise(): Promise<void> {
  return ownConstructor(new NativePromise<void>((resolve) => resolve()))
}

/**
 * Waits for a promise with a native `await` and hands the outcome to a callback. A native `await` of a promise whose
 * `constructor` is the intrinsic attaches its reaction directly: no `then` is read from the promise or its
 * prototypes, and no `Symbol.species` is read from the constructor, so neither can decide what runs.
 *
 * @param promise - The promise to wait for.
 * @param onValue - Called with the value.
 * @param onReason - Called with the rejection reason, or with the error the wait itself threw.
 */
async function settle(
  promise: Promise<unknown>,
  onValue: (value: unknown) => void,
  onReason: (reason: unknown) => void
): Promise<void> {
  let value: unknown
  let reason: unknown
  let fulfilled = false
  try {
    value = await promise
    fulfilled = true
  } catch (error) {
    reason = error
  }
  if (fulfilled) onValue(value)
  else onReason(reason)
}

/**
 * Waits for a promise this library made, giving it an own `constructor` first.
 *
 * @param promise - A promise of the library's own, never a host's.
 * @param onValue - Called with the value.
 * @param onReason - Called with the rejection reason.
 */
export function absorbOwned(
  promise: Promise<unknown>,
  onValue: (value: unknown) => void,
  onReason: (reason: unknown) => void
): void {
  ownConstructor(promise)
  void settle(promise, onValue, onReason)
}

/**
 * Waits for a promise a host made, without writing to it.
 *
 * @param promise - A native promise of the host's.
 * @param onValue - Called with the value.
 * @param onReason - Called with the rejection reason.
 * @returns `false` when the wait threw before it suspended, which a replaced `constructor` makes it do: the callbacks
 * are not called, and the host's own rejection, if there is one, stays unhandled.
 */
export function absorbHost(
  promise: Promise<unknown>,
  onValue: (value: unknown) => void,
  onReason: (reason: unknown) => void
): boolean {
  let suspended = false
  let refused = false
  void settle(promise, onValue, (reason) => {
    // The wait threw before it suspended, so this is the read of the constructor and not a rejection of the promise.
    if (suspended) onReason(reason)
    else refused = true
  })
  suspended = true
  return !refused
}

/**
 * The error of a wait that could not be made because a promise of a host cannot be consumed: its `constructor` was
 * replaced by something that throws. The caller fails with it instead of going on as if the promise had settled.
 *
 * @returns An error with an own, read-only `code`.
 */
export function unconsumable(): Error {
  const error = new ErrorClass(
    'A promise of the host could not be waited for, because its constructor was replaced.'
  )
  defineProperty(error, 'code', { __proto__: null, value: POLLUTED_CODE } as PropertyDescriptor)
  return error
}

/** Takes the outcome of a promise that nobody waits for, so neither a value nor a rejection is passed on. */
export const ignore = (): undefined => undefined
