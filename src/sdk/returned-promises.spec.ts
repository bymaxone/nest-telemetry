/**
 * @fileoverview Tests that a promise this library returns on a decision path carries its own `constructor`, so a
 * caller that awaits it reads no `Promise.prototype.constructor` after the library's last check.
 * @layer sdk
 */
import {
  clearHandle,
  clearPendingStart,
  createHandle,
  registerHandle,
  shutdownTelemetry,
  setPendingStart
} from './handle'
import { absorbHost, ownConstructor, resolvedPromise } from './native-promise'
import { startTelemetry } from './start'

/**
 * Waits for `promise` the way a native `await` does: the `then` of the engine is applied while
 * `Promise.prototype.constructor` is a getter that throws, because that is when a caller reads the constructor of
 * what the library handed back. The slot is restored at once, before anything else runs.
 */
function awaitedWhileConstructorThrows<T>(promise: Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(
    Promise.prototype,
    'constructor'
  ) as PropertyDescriptor
  const then = Promise.prototype.then
  return new Promise<T>((resolve, reject) => {
    Object.defineProperty(Promise.prototype, 'constructor', {
      configurable: true,
      get(): never {
        throw new Error('hostile constructor')
      }
    })
    try {
      Reflect.apply(then, promise, [resolve, reject])
    } catch (error) {
      reject(error)
    } finally {
      Object.defineProperty(Promise.prototype, 'constructor', original)
    }
  })
}

/** A native promise of a host whose `constructor` throws when a `then` reads it. */
function unconsumable(): Promise<void> {
  const promise = Promise.resolve()
  Object.defineProperty(promise, 'constructor', {
    configurable: true,
    get(): never {
      throw new Error('hostile constructor')
    }
  })
  return promise
}

afterEach(() => {
  clearHandle()
  clearPendingStart()
})

describe('the promises that the library returns', () => {
  it('hands back a start that a caller can await after the constructor of promises was replaced', async () => {
    // Scenario: the call returns before the host replaces the slot; awaiting the answer reads no constructor from the
    // prototype, so the caller gets the disabled handle and not the host's error.
    const answer = startTelemetry({ enabled: false })
    const handle = await awaitedWhileConstructorThrows(answer)
    expect(handle.enabled).toBe(false)
  })

  it('hands back a shutdown that a caller can await after the constructor of promises was replaced', async () => {
    // Scenario: a flush that is pending when the host replaces the slot still resolves for the caller that awaits it.
    const handle = createHandle(() => Promise.resolve())
    await awaitedWhileConstructorThrows(handle.shutdown())
    await awaitedWhileConstructorThrows(handle.shutdown())
  })

  it('hands back the module-level shutdown that a caller can await after the constructor was replaced', async () => {
    // Scenario: the application awaits the shutdown of the registered handle under the replaced slot.
    registerHandle(createHandle(() => Promise.resolve()))
    await awaitedWhileConstructorThrows(shutdownTelemetry())
  })

  it('answers the shutdown of the registered handle when the start in progress cannot be consumed', async () => {
    // Scenario: the start another copy has under way is a promise whose constructor throws; the shutdown does not wait
    // for what it cannot read, and goes on to the handle.
    const stop = jest.fn(() => Promise.resolve())
    registerHandle(createHandle(stop))
    setPendingStart(unconsumable() as never)
    await shutdownTelemetry()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('answers the shutdown when the handle of another copy hands back a promise that cannot be consumed', async () => {
    // Scenario: a handle registered by another copy answers its shutdown with a promise of the host that throws when
    // attached to; the shutdown resolves instead of rejecting with the planted error.
    registerHandle({ enabled: true, stopping: false, shutdown: unconsumable })
    await expect(shutdownTelemetry()).resolves.toBeUndefined()
  })

  it('rejects the module-level shutdown with the reason of a failed flush', async () => {
    // Scenario: the registered handle fails to flush; the caller of the shutdown sees the failure.
    registerHandle(createHandle(() => Promise.reject(new Error('flush failed'))))
    await expect(shutdownTelemetry()).rejects.toThrow('flush failed')
  })

  it('rejects the module-level shutdown when reading the handle throws', async () => {
    // Scenario: a handle whose shutdown throws synchronously is reported to the caller, never swallowed.
    registerHandle({
      enabled: true,
      stopping: false,
      shutdown: () => {
        throw new Error('sync failure')
      }
    })
    await expect(shutdownTelemetry()).rejects.toThrow('sync failure')
  })
})

describe('a start beside a promise that cannot be consumed', () => {
  it('answers the disabled handle when the start already under way cannot be consumed', async () => {
    // Scenario: the start another copy has under way is a promise whose constructor throws; the second caller is
    // refused with the disabled handle instead of waiting on what it cannot read.
    setPendingStart(unconsumable() as never)
    const handle = await startTelemetry({})
    expect(handle.enabled).toBe(false)
  })

  it('goes on once the flush of a stopping handle cannot be consumed', async () => {
    // Scenario: a handle that is stopping answers its shutdown with a promise that cannot be consumed; the start does
    // not wait for it and answers with the handle that is registered.
    const stopping = { enabled: true, stopping: true, shutdown: unconsumable }
    registerHandle(stopping)
    await expect(startTelemetry({})).resolves.toBe(stopping)
  })
})

describe('ownConstructor and resolvedPromise', () => {
  it('gives a promise an own constructor equal to the intrinsic', () => {
    // Scenario: the tag is an own data property that the prototype chain cannot change.
    const promise = ownConstructor(new Promise<void>(() => undefined))
    expect(Object.getOwnPropertyDescriptor(promise, 'constructor')?.value).toBe(Promise)
  })

  it('returns a frozen promise as it is, without throwing', () => {
    // Scenario: a promise that cannot take the property is handed back unchanged.
    const frozen = Object.freeze(new Promise<void>(() => undefined))
    expect(ownConstructor(frozen)).toBe(frozen)
  })

  it('builds an already fulfilled promise that carries its own constructor', async () => {
    // Scenario: the resolved promise for a handle that stopped nothing is tagged and fulfils with nothing.
    const promise = resolvedPromise()
    expect(Object.getOwnPropertyDescriptor(promise, 'constructor')?.value).toBe(Promise)
    await expect(promise).resolves.toBeUndefined()
  })

  it('does not write to a promise of a host that cannot be consumed', () => {
    // Scenario: the host's promise keeps its own getter, and the attach reports failure instead of rewriting it.
    const host = unconsumable()
    const before = Object.getOwnPropertyDescriptor(host, 'constructor')
    expect(
      absorbHost(
        host,
        () => undefined,
        () => undefined
      )
    ).toBe(false)
    expect(Object.getOwnPropertyDescriptor(host, 'constructor')).toEqual(before)
  })
})
