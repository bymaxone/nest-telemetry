/**
 * @fileoverview Tests the count of names that make this realm's Object.prototype differ from a fresh realm's.
 * @layer sdk
 */
import { pollutedNames } from './prototype-guard'

/** Runs `run` with a descriptor put on the root prototype, and removes or restores it after. */
function plant(name: string, descriptor: PropertyDescriptor, run: () => void): void {
  const before = Object.getOwnPropertyDescriptor(Object.prototype, name)
  Object.defineProperty(Object.prototype, name, { configurable: true, ...descriptor })
  try {
    run()
  } finally {
    if (before === undefined) delete (Object.prototype as unknown as Record<string, unknown>)[name]
    else Object.defineProperty(Object.prototype, name, before)
  }
}

describe('pollutedNames', () => {
  it('counts nothing for a clean realm', () => {
    // Scenario: a realm nobody touched holds exactly the names a fresh one holds.
    expect(pollutedNames()).toBe(0)
  })

  it.each([
    [
      'an enumerable data name, as a JSON pollution plants it',
      { value: 1, enumerable: true, writable: true }
    ],
    ['a name that is not enumerable', { value: 1, writable: true }],
    ['an accessor', { get: () => 1 }],
    ['a read-only name', { value: 1 }]
  ])('counts a planted name: %s', (_label, descriptor) => {
    // Scenario: any string name the engine does not define counts once, whatever its flags.
    plant('plantedForTheTest', descriptor, () => {
      expect(pollutedNames()).toBe(1)
    })
    expect(pollutedNames()).toBe(0)
  })

  it.each(['hasOwnProperty', 'toString', 'constructor', 'valueOf', 'isPrototypeOf'])(
    'counts a standard name overwritten with another value: %s',
    (name) => {
      // Scenario: a name the engine does define, swapped for something else, is not the engine's any more.
      plant(name, { value: 1, writable: true }, () => {
        expect(pollutedNames()).toBe(1)
      })
      expect(pollutedNames()).toBe(0)
    }
  )

  it('counts a standard function swapped for another function of another text, and one made writable', () => {
    // Scenario: the swap is caught by the function's text, and a flag looser than the engine's is a change.
    plant('toString', { value: () => 'x', writable: true }, () => {
      expect(pollutedNames()).toBe(1)
    })
    plant('valueOf', { value: Object.prototype.valueOf, writable: true, enumerable: true }, () => {
      expect(pollutedNames()).toBe(1)
    })
  })

  it('counts a standard name that is gone, and counts it once with its descriptor changed', () => {
    // Scenario: a name the fresh realm holds and this one lacks is a difference too.
    const before = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'isPrototypeOf'
    ) as PropertyDescriptor
    delete (Object.prototype as unknown as Record<string, unknown>)['isPrototypeOf']
    try {
      expect(pollutedNames()).toBe(1)
    } finally {
      Object.defineProperty(Object.prototype, 'isPrototypeOf', before)
    }
  })

  it('never runs a getter or a setter planted under a descriptor field name', () => {
    // Scenario: descriptors inherit from the prototype under test; an accessor called get, set or value
    // planted there must not run while the realm is compared.
    let ran = 0
    for (const name of ['get', 'set', 'value']) {
      Object.defineProperty(Object.prototype, name, {
        configurable: true,
        get: () => {
          ran += 1
          return undefined
        }
      })
    }
    // Defining the later names already read the earlier ones, as every descriptor does; only the comparison counts.
    ran = 0
    try {
      expect(pollutedNames()).toBe(3)
      expect(ran).toBe(0)
    } finally {
      for (const name of ['get', 'set', 'value']) {
        delete (Object.prototype as unknown as Record<string, unknown>)[name]
      }
    }
  })
})
