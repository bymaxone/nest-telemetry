/**
 * @fileoverview Tests that the comparison of this realm's Object.prototype with a fresh realm's catches a
 * standard function that was swapped for another of the same text, one whose text changed with the swap
 * already in place when the module loaded, and a flag looser than the fresh realm's.
 * @layer sdk
 */
import { runInNewContext } from 'node:vm'

import { readBuiltins } from './prototype-guard'
import type { pollutedNames as PollutedNames } from './prototype-guard'

/** The `Object.prototype` of a fresh realm, whose functions have the engine's text and another identity. */
const fresh = runInNewContext('Object.prototype') as object

/** The descriptor of a name on the root prototype of this realm. */
function descriptorOf(name: string): PropertyDescriptor {
  return Object.getOwnPropertyDescriptor(Object.prototype, name) as PropertyDescriptor
}

/** Runs `run` with `name` redefined on the root prototype, and puts the original back after. */
function redefined(name: string, descriptor: PropertyDescriptor, run: () => void): void {
  const original = descriptorOf(name)
  Object.defineProperty(Object.prototype, name, descriptor)
  try {
    run()
  } finally {
    Object.defineProperty(Object.prototype, name, original)
  }
}

/** Loads a fresh copy of the guard, so what it snapshots is the prototype as it is at this moment. */
function loadGuard(): typeof PollutedNames {
  let loaded: typeof PollutedNames | undefined
  jest.isolateModules(() => {
    loaded = (require('./prototype-guard') as { pollutedNames: typeof PollutedNames }).pollutedNames
  })
  return loaded as typeof PollutedNames
}

describe("a standard function swapped for the fresh realm's own, of the same text", () => {
  const { pollutedNames } = require('./prototype-guard') as { pollutedNames: typeof PollutedNames }

  it.each([
    ['value', 'toString', 'value'],
    ['getter', '__proto__', 'get'],
    ['setter', '__proto__', 'set']
  ] as const)('is counted by identity, for its %s', (_label, name, field) => {
    // Scenario: the text is the engine's, so only the identity of the function that this module met tells.
    const theirs = Object.getOwnPropertyDescriptor(fresh, name) as PropertyDescriptor
    const swapped = { ...descriptorOf(name), [field]: theirs[field] }
    expect(pollutedNames()).toBe(0)
    redefined(name, swapped, () => {
      expect(pollutedNames()).toBe(1)
    })
    expect(pollutedNames()).toBe(0)
  })
})

describe('a standard name that changed before the guard loaded', () => {
  it("is counted by the text of a function that is not the engine's, with the identity unchanged", () => {
    // Scenario: loaded with a toString of another text already in place, the guard's own baseline is that
    // function, so identity cannot tell and the text must.
    const replacement = (): string => 'x'
    redefined('toString', { ...descriptorOf('toString'), value: replacement }, () => {
      expect(loadGuard()()).toBe(1)
    })
  })

  it('is counted when a function became a value that is not a function, identity unchanged', () => {
    // Scenario: a value that is not a function where the engine has one differs at once, and is not read as text.
    redefined('toString', { ...descriptorOf('toString'), value: 1 }, () => {
      expect(loadGuard()()).toBe(1)
    })
  })

  it('is not counted when the guard loaded without a name that is back, as the fresh realm has it', () => {
    // Scenario: a name that was absent when the guard loaded has no identity to compare, so the fresh
    // realm's descriptor decides, and the engine's own function is the one that is there again.
    const original = descriptorOf('isPrototypeOf')
    delete (Object.prototype as unknown as Record<string, unknown>)['isPrototypeOf']
    let pollutedNames: typeof PollutedNames
    try {
      pollutedNames = loadGuard()
    } finally {
      Object.defineProperty(Object.prototype, 'isPrototypeOf', original)
    }
    expect(pollutedNames()).toBe(0)
  })
})

describe("a flag looser than the fresh realm's", () => {
  /** Loads a guard whose fresh realm holds `toString` with `flags`, and the rest as this realm's. */
  function guardWithFreshFlags(flags: PropertyDescriptor): typeof PollutedNames {
    let loaded: typeof PollutedNames | undefined
    jest.isolateModules(() => {
      const descriptors = Object.getOwnPropertyDescriptors(Object.prototype) as Record<
        string,
        PropertyDescriptor
      >
      descriptors['toString'] = { ...descriptors['toString'], ...flags }
      jest.doMock('node:vm', () => ({
        runInNewContext: () => ({
          objects: readBuiltins(),
          descriptors,
          sourceOf: (value: unknown): string => Function.prototype.toString.call(value)
        })
      }))
      loaded = (require('./prototype-guard') as { pollutedNames: typeof PollutedNames })
        .pollutedNames
    })
    jest.dontMock('node:vm')
    return loaded as typeof PollutedNames
  }

  it.each([['writable'], ['configurable']] as const)('is counted for %s', (flag) => {
    // Scenario: a fresh realm that is tighter than this one, a frozen runtime, makes this realm's flag a change.
    expect(guardWithFreshFlags({ [flag]: false })()).toBe(1)
  })

  it('is not counted when this realm is the tighter one', () => {
    // Scenario: a flag tighter than the fresh realm's is safe (writable only, since a name that is no longer
    // configurable could not be put back).
    const guard = guardWithFreshFlags({})
    redefined('toString', { ...descriptorOf('toString'), writable: false }, () => {
      expect(guard()).toBe(0)
    })
  })
})

describe('a value that is not a function in the fresh realm', () => {
  it('is counted when this realm holds something else there', () => {
    // Scenario: where the fresh realm holds a plain value, the same value is the only one that is alike; a
    // function in its place is a change. (A fresh realm that held a value there is mocked.)
    let guard: typeof PollutedNames | undefined
    jest.isolateModules(() => {
      const descriptors = Object.getOwnPropertyDescriptors(Object.prototype) as Record<
        string,
        PropertyDescriptor
      >
      descriptors['toString'] = { ...descriptors['toString'], value: 5 }
      jest.doMock('node:vm', () => ({
        runInNewContext: () => ({
          objects: readBuiltins(),
          descriptors,
          sourceOf: (value: unknown): string => Function.prototype.toString.call(value)
        })
      }))
      guard = (require('./prototype-guard') as { pollutedNames: typeof PollutedNames })
        .pollutedNames
    })
    jest.dontMock('node:vm')
    expect((guard as typeof PollutedNames)()).toBe(1)
  })
})
