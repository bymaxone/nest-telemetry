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
import { DISABLED_HANDLE, startTelemetry } from './start'

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

  it('rejects the shutdown when the start in progress cannot be consumed, and stops nothing early', async () => {
    // Scenario: the start another copy has under way is a promise whose constructor throws; the shutdown cannot wait
    // for it, so it fails with a typed error and does not drain a handle the start may be about to replace.
    const stop = jest.fn(() => Promise.resolve())
    registerHandle(createHandle(stop))
    setPendingStart(unconsumable() as never)
    await expect(shutdownTelemetry()).rejects.toMatchObject({
      code: 'BYMAX_TELEMETRY_REALM_POLLUTED'
    })
    expect(stop).not.toHaveBeenCalled()
  })

  it('rejects the shutdown when the handle of another copy hands back a promise that cannot be consumed', async () => {
    // Scenario: a handle registered by another copy answers its shutdown with a promise of the host that throws when
    // attached to; the shutdown must not report a flush it could not see as a success, so it rejects with a typed error.
    registerHandle({ enabled: true, stopping: false, shutdown: unconsumable })
    await expect(shutdownTelemetry()).rejects.toMatchObject({
      code: 'BYMAX_TELEMETRY_REALM_POLLUTED'
    })
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

  it('rejects once the flush of a stopping handle cannot be consumed', async () => {
    // Scenario: a handle that is stopping answers its shutdown with a promise that cannot be consumed; the start cannot
    // tell the flush ended, so it fails with a typed error instead of going on.
    registerHandle({ enabled: true, stopping: true, shutdown: unconsumable })
    await expect(startTelemetry({})).rejects.toMatchObject({
      code: 'BYMAX_TELEMETRY_REALM_POLLUTED'
    })
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

/** Lets every pending reaction run, and the unhandled-rejection check of the process with them. */
const ticks = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('the flush of a handle beside a host that plants something on Promise', () => {
  it('rejects with the reason of the flush, and leaves nothing unhandled, when Symbol.species throws', async () => {
    // Scenario: a getter on Promise[Symbol.species] throws when a `then` is applied to the promise the SDK answered
    // with; the wait is a native await, which reads no species, so the reason arrives and nothing is left unhandled.
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const reason = new Error('flush failed')
    const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species) as PropertyDescriptor
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get(): never {
        throw new Error('hostile species')
      }
    })
    let flushed: Promise<void>
    try {
      // The slot is put back as soon as the call returns: the library's wait is made inside the call, and a test
      // that suspended with the getter in place would have the test runner read it.
      flushed = createHandle(() => Promise.reject(reason)).shutdown()
    } finally {
      Object.defineProperty(Promise, Symbol.species, original)
    }
    let caught: unknown
    try {
      await flushed
    } catch (error) {
      caught = error
    }
    await ticks()
    process.off('unhandledRejection', unhandled)
    expect(caught).toBe(reason)
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('does not let a then of the promise the SDK answered with settle the flush', async () => {
    // Scenario: the promise the SDK answered with rejects but holds a `then` of its own that reports success;
    // returning or resolving it would read that `then`, so the flush is waited for with a native await instead.
    const reason = new Error('flush failed')
    const stopping = Promise.reject(reason)
    Object.defineProperty(stopping, 'then', {
      value: (onValue: () => void): void => onValue()
    })
    await expect(createHandle(() => stopping).shutdown()).rejects.toBe(reason)
  })

  it('rejects with the error of a stop that throws before it returns a promise', async () => {
    // Scenario: stopping the SDK throws at once, not through a promise; the caller of the flush sees that error and the
    // handle is finished, as for any failed flush.
    const reason = new Error('stop threw')
    const handle = createHandle(() => {
      throw reason
    })
    await expect(handle.shutdown()).rejects.toBe(reason)
    expect(handle.stopping).toBe(false)
  })

  it('does not let the host redefine the constructor of the flush it was handed', async () => {
    // Scenario: the host redefines `constructor` of the flush promise as a getter that throws, so that the next wait
    // on it fails open; the own property is read-only and not configurable, so the definition is refused.
    const reason = new Error('flush failed')
    const flushed = createHandle(() => Promise.reject(reason)).shutdown()
    const redefined = Reflect.defineProperty(flushed, 'constructor', {
      get(): never {
        throw new Error('hostile constructor')
      }
    })
    expect(redefined).toBe(false)
    await expect(flushed).rejects.toBe(reason)
  })
})

describe('the handles handed to the host', () => {
  it('freezes the disabled handle and the handle of a started SDK', () => {
    // Scenario: a host that gives an earlier handle a `then`, or replaces its `shutdown`, would decide what the next
    // promise that resolves with it reads; a frozen handle refuses both.
    const started = createHandle(() => Promise.resolve())
    for (const handle of [DISABLED_HANDLE, started]) {
      expect(Object.isFrozen(handle)).toBe(true)
      expect(Reflect.set(handle, 'then', () => undefined)).toBe(false)
      expect(Reflect.set(handle, 'shutdown', () => undefined)).toBe(false)
      expect('then' in handle).toBe(false)
    }
  })
})
