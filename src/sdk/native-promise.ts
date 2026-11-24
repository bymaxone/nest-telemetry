/**
 * @fileoverview Attaches handlers to a promise with the `then` this library read when it loaded, without a
 * `constructor` that something replaced on `Promise.prototype` deciding what runs.
 * @layer sdk
 *
 * `Promise.prototype.then` reads `constructor` of the promise it is called on, for a species, through the prototype
 * chain. A getter planted there throws out of `then`, or hands back a constructor of the planter's. A promise this
 * library made gets its own `constructor`, so the lookup ends on it; a promise a host made is never written to, so
 * a failed attach is reported to the caller, which fails closed.
 */
import { apply, defineProperty, NativePromise, promiseThen } from './primordials'

/**
 * Attaches handlers to a promise this library made, giving it an own `constructor` first.
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
  defineProperty(promise, 'constructor', {
    __proto__: null,
    value: NativePromise,
    configurable: true,
    writable: true
  } as PropertyDescriptor)
  apply(promiseThen, promise, [onValue, onReason])
}

/**
 * Attaches handlers to a promise a host made, without writing to it.
 *
 * @param promise - A native promise of the host's.
 * @param onValue - Called with the value.
 * @param onReason - Called with the rejection reason.
 * @returns `false` when the attach threw, which a replaced `constructor` makes it do: the handlers are not attached,
 * and the host's own rejection, if there is one, stays unhandled.
 */
export function absorbHost(
  promise: Promise<unknown>,
  onValue: (value: unknown) => void,
  onReason: (reason: unknown) => void
): boolean {
  try {
    apply(promiseThen, promise, [onValue, onReason])
    return true
  } catch {
    return false
  }
}
