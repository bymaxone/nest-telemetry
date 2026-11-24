/**
 * @fileoverview Waits for a promise through the `then` captured at load, without a `then` that something installed on
 * `Promise.prototype` deciding what runs.
 * @layer sdk
 *
 * A bare `await` reads `constructor` of the promise and, when it is not the intrinsic, reads `then` of the promise it
 * builds: a host can make both reads answer once and restore themselves, so the checks around the wait find nothing.
 * The captured `then` reads neither; its callbacks receive what the promise settled with. A promise this library made
 * gets its own `constructor`; a promise a host made is never written to, so a wait that cannot be made is reported to
 * the caller, which fails closed.
 */
import { POLLUTED_CODE } from './error-code'
import {
  apply,
  dataValue,
  defineProperty,
  ErrorClass,
  getOwnPropertyDescriptor,
  getPrototypeOf,
  NativePromise,
  promisePrototype,
  promiseThen
} from './primordials'

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
 * Waits for a promise by calling the `then` captured when the library loaded, and hands the outcome to callbacks. The
 * callbacks are the reactions themselves, so what they receive is what the promise settled with: no `then` is read
 * from the promise or its prototypes, and a `constructor` or `Symbol.species` that something replaced can only decide
 * what the promise derived from the call is built from, which nobody reads.
 *
 * @param promise - The promise to wait for.
 * @param onValue - Called with the value.
 * @param onReason - Called with the rejection reason.
 * @returns `false` when the call threw before a reaction was attached, which a `constructor` that throws makes it do:
 * neither callback is called.
 */
function attach(
  promise: Promise<unknown>,
  onValue: (value: unknown) => void,
  onReason: (reason: unknown) => void
): boolean {
  try {
    apply(promiseThen, promise, [onValue, onReason])
  } catch {
    return false
  }
  return true
}

/**
 * Whether a native `await` of a promise ends its lookup of `constructor` on the intrinsic, judged from descriptors
 * alone, so no getter runs: its own `constructor`, or the engine's `Promise.prototype` when nothing shadows it, must be
 * a data property that holds the captured constructor. With nothing between this check and the await that can run
 * code, the await reads the very value judged here.
 *
 * @param promise - A native promise.
 * @returns `true` when the await attaches its reaction directly.
 */
function endsOnIntrinsic(promise: Promise<unknown>): boolean {
  if (getOwnPropertyDescriptor(promise, 'constructor') !== undefined) {
    return dataValue(promise, 'constructor') === NativePromise
  }
  return (
    getPrototypeOf(promise) === promisePrototype &&
    dataValue(promisePrototype, 'constructor') === NativePromise
  )
}

/**
 * Waits for a promise with a native `await` and hands the outcome to a callback. A native `await` of a promise whose
 * `constructor` is the intrinsic attaches its reaction directly: no `then` is read from the promise or its
 * prototypes, and no `Symbol.species` is read from the constructor.
 *
 * @param promise - A promise with an own `constructor`.
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
 * Waits for a promise this library or a dependency made. It is given an own `constructor` first and then awaited
 * natively; a promise that cannot take one, a frozen one, is waited for through the captured `then` instead, because
 * a bare `await` would read a `constructor` and a `then` that something replaced.
 *
 * @param promise - A promise of the library's own or of a dependency, never a host's.
 * @param onValue - Called with the value.
 * @param onReason - Called with the rejection reason, or with the error the wait itself threw.
 */
export function absorbOwned(
  promise: Promise<unknown>,
  onValue: (value: unknown) => void,
  onReason: (reason: unknown) => void
): void {
  ownConstructor(promise)
  if (endsOnIntrinsic(promise)) {
    void settle(promise, onValue, onReason)
  } else if (!attach(promise, onValue, onReason)) {
    onReason(unconsumable())
  }
}

/**
 * Waits for a promise a host made, without writing to it.
 *
 * @param promise - A native promise of the host's.
 * @param onValue - Called with the value.
 * @param onReason - Called with the rejection reason.
 * @returns `false` when the wait threw before a reaction was attached, which a replaced `constructor` makes it do: the
 * callbacks are not called, and the host's own rejection, if there is one, stays unhandled.
 */
export function absorbHost(
  promise: Promise<unknown>,
  onValue: (value: unknown) => void,
  onReason: (reason: unknown) => void
): boolean {
  if (endsOnIntrinsic(promise)) {
    void settle(promise, onValue, onReason)
    return true
  }
  return attach(promise, onValue, onReason)
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
