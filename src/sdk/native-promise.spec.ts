/**
 * @fileoverview Tests that a wait on a promise hands the callbacks what the promise settled with, whatever a host does
 * to `Promise.prototype` while the wait is made.
 * @layer sdk
 */
import { absorbHost, absorbOwned } from './native-promise'

/** The two slots of `Promise.prototype` that a wait reads, to put back whatever an attacker did to them. */
const SLOTS = ['constructor', 'then'] as const

/**
 * Installs accessors for `constructor` and `then` on `Promise.prototype` that answer once with a forgery and each put
 * its real slot back as soon as it is read, so the checks before and after the wait find nothing.
 *
 * @param forged - What the forged `then` hands the callbacks.
 * @returns How many times each forgery was read.
 */
function plantSelfRestoringForgery(forged: string): { reads: number } {
  const original = SLOTS.map((name) => Object.getOwnPropertyDescriptor(Promise.prototype, name))
  const seen = { reads: 0 }
  const restore = (name: (typeof SLOTS)[number]): void => {
    Object.defineProperty(
      Promise.prototype,
      name,
      original[SLOTS.indexOf(name)] as PropertyDescriptor
    )
  }
  Object.defineProperty(Promise.prototype, 'constructor', {
    configurable: true,
    get: () => {
      seen.reads += 1
      restore('constructor')
      return Object
    }
  })
  Object.defineProperty(Promise.prototype, 'then', {
    configurable: true,
    get: () => {
      seen.reads += 1
      restore('then')
      return (onFulfilled: (value: unknown) => void): void => onFulfilled(forged)
    }
  })
  return seen
}

/** Puts the real slots back when a test ends, whatever it did. */
function restoreSlots(original: (PropertyDescriptor | undefined)[]): void {
  SLOTS.forEach((name, at) =>
    Object.defineProperty(Promise.prototype, name, original[at] as PropertyDescriptor)
  )
}

describe('a wait on a promise of a host', () => {
  const original = SLOTS.map((name) => Object.getOwnPropertyDescriptor(Promise.prototype, name))
  afterEach(() => restoreSlots(original))

  it('hands over the value the promise holds when the slots forge one and restore themselves', async () => {
    // Scenario: a host call installs one-shot, self-restoring accessors for `constructor` and `then` on
    // `Promise.prototype` and returns its promise; a bare await reads them and a forged `then` answers.
    const host = Promise.resolve('real')
    plantSelfRestoringForgery('forged')
    const got = await new Promise<unknown>((resolve) => {
      absorbHost(host, resolve, resolve)
    })
    expect(got).toBe('real')
  })

  it('hands over the reason the promise holds when the slots forge one and restore themselves', async () => {
    // Scenario: the same attacker, on a promise that rejects.
    const host = Promise.reject(new Error('real reason'))
    plantSelfRestoringForgery('forged')
    const got = await new Promise<unknown>((resolve) => {
      absorbHost(host, resolve, resolve)
    })
    expect(got).toEqual(new Error('real reason'))
  })

  it('refuses, with no callback, when the wait itself throws', () => {
    // Scenario: a promise whose own `constructor` throws when read; the wait cannot be made and says so.
    const host = Promise.resolve(1)
    Object.defineProperty(host, 'constructor', {
      get: () => {
        throw new Error('boom')
      }
    })
    const called = jest.fn()
    expect(absorbHost(host, called, called)).toBe(false)
    expect(called).not.toHaveBeenCalled()
  })
})

describe('a wait on a promise a dependency made', () => {
  const original = SLOTS.map((name) => Object.getOwnPropertyDescriptor(Promise.prototype, name))
  afterEach(() => restoreSlots(original))

  it('hands over the value when the promise could not take an own constructor', async () => {
    // Scenario: a frozen promise cannot be tagged, so the same attacker reaches it; the value is still the real one.
    const owned = Object.freeze(Promise.resolve('real'))
    plantSelfRestoringForgery('forged')
    const got = await new Promise<unknown>((resolve) => {
      absorbOwned(owned, resolve, resolve)
    })
    expect(got).toBe('real')
  })

  it('rejects with the typed error when the wait on a promise that cannot be tagged throws', async () => {
    // Scenario: the wait itself throws for a dependency's promise whose own `constructor` cannot be replaced; the caller is told and nothing is left hanging.
    const owned = Promise.resolve(1)
    Object.defineProperty(owned, 'constructor', {
      get: () => {
        throw new Error('boom')
      }
    })
    const got = await new Promise<unknown>((resolve) => {
      absorbOwned(owned, resolve, resolve)
    })
    expect(got).toMatchObject({ code: 'BYMAX_TELEMETRY_REALM_POLLUTED' })
  })
})
