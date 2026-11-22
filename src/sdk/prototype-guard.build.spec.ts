/**
 * @fileoverview Tests when the fresh realm is built, and that a realm that cannot be built counts as polluted.
 * @layer sdk
 */
import type { pollutedNames as PollutedNames } from './prototype-guard'

/** Loads a fresh copy of the guard with the vm module replaced by `runInNewContext`, and returns what it needs. */
function guardWith(runInNewContext: jest.Mock): typeof PollutedNames {
  let loaded: typeof PollutedNames | undefined
  jest.isolateModules(() => {
    jest.doMock('node:vm', () => ({ runInNewContext }))
    loaded = (require('./prototype-guard') as { pollutedNames: typeof PollutedNames }).pollutedNames
  })
  jest.dontMock('node:vm')
  return loaded as typeof PollutedNames
}

/** The real thing the vm module would answer: this realm's own descriptors, so every comparison is clean. */
const real = (): object => ({
  descriptors: Object.getOwnPropertyDescriptors(Object.prototype),
  sourceOf: (value: unknown): string => Function.prototype.toString.call(value)
})

describe('the fresh realm', () => {
  it('is built when the module loads, once, and not again at the first count', () => {
    // Scenario: building it needs the vm module, which reads names from options it makes itself, so it is done
    // while the process is normally clean and kept.
    const runInNewContext = jest.fn(real)
    const pollutedNames = guardWith(runInNewContext)
    expect(runInNewContext).toHaveBeenCalledTimes(1)
    expect(pollutedNames()).toBe(0)
    expect(pollutedNames()).toBe(0)
    expect(runInNewContext).toHaveBeenCalledTimes(1)
  })

  it('is built again at the first count when the build at load failed, and the count is normal', () => {
    // Scenario: a build that failed at load is retried once the name is gone.
    const runInNewContext = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('planted option')
      })
      .mockImplementation(real)
    const pollutedNames = guardWith(runInNewContext)
    expect(pollutedNames()).toBe(0)
    expect(runInNewContext).toHaveBeenCalledTimes(2)
  })

  it('makes every count one while it cannot be built, with no error and nothing the failure said', () => {
    // Scenario: a realm that cannot be compared with a fresh one cannot be trusted: it counts as polluted.
    const runInNewContext = jest.fn(() => {
      throw new Error('SECRET-PLANTED-OPTION')
    })
    const pollutedNames = guardWith(runInNewContext)
    expect(pollutedNames()).toBe(1)
    expect(pollutedNames()).toBe(1)
  })
})
