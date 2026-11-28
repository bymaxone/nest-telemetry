/**
 * @fileoverview Tests that each of the two links of the check of `Promise.prototype.constructor` counts a change on its
 * own: the link from the constructor back to the prototype, and the text of the constructor.
 * @layer sdk
 */
import { readBuiltins } from './prototype-guard'
import type { pollutedNames as PollutedNames } from './prototype-guard'

/** What the fresh realm would answer: this realm's own descriptors, so every comparison is clean. */
const real = (promiseSource: string): object => ({
  objects: readBuiltins(),
  descriptors: Object.getOwnPropertyDescriptors(Object.prototype),
  sourceOf: (value: unknown): string => Function.prototype.toString.call(value),
  promiseSource
})

/** Loads a fresh copy of the guard, with the fresh realm answering as given, and counts while `during` runs. */
function countedWith(promiseSource: (planted: unknown) => string, plant: () => () => void): number {
  const restore = plant()
  let count = -1
  try {
    jest.isolateModules(() => {
      const planted = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor')?.value
      jest.doMock('node:vm', () => ({
        runInNewContext: (): object => real(promiseSource(planted))
      }))
      const guard = require('./prototype-guard') as { pollutedNames: typeof PollutedNames }
      count = guard.pollutedNames()
    })
  } finally {
    jest.dontMock('node:vm')
    restore()
  }
  return count
}

const slot = (): PropertyDescriptor =>
  Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor') as PropertyDescriptor
const engineSource = Function.prototype.toString.call(Promise)

describe('the check of Promise.prototype.constructor', () => {
  it('counts nothing when the slot, the link and the text all agree with the fresh realm', () => {
    // Scenario: the baseline for the two cases below, so a count there comes from the one change made.
    expect(
      countedWith(
        () => engineSource,
        () => (): undefined => undefined
      )
    ).toBe(0)
  })

  it('counts a text that differs from the fresh realm even when the slot and the link agree', () => {
    // Scenario: the constructor is the engine's own Promise and links back to the prototype, but the fresh realm
    // reads another text for its Promise; only the comparison of the text can name that.
    expect(
      countedWith(
        () => 'function Promise() { [tampered] }',
        () => (): undefined => undefined
      )
    ).toBe(1)
  })

  it('counts one more when the prototype of a planted constructor is not the one checked', () => {
    // Scenario: two planted functions that the fresh realm is made to read the same text for; one takes
    // Promise.prototype as its prototype and the other keeps its own, so the link back to the prototype is the only
    // difference between the two counts, and it is one name.
    const original = slot()
    const counted = (linked: boolean): number => {
      const host = function Host(): void {}
      if (linked) host.prototype = Promise.prototype
      return countedWith(
        (planted) => Function.prototype.toString.call(planted),
        () => {
          Object.defineProperty(Promise.prototype, 'constructor', { ...original, value: host })
          return () => Object.defineProperty(Promise.prototype, 'constructor', original)
        }
      )
    }
    expect(counted(false)).toBe(counted(true) + 1)
  })
})
