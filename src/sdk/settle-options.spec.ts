/**
 * @fileoverview Tests that the copy of the options of a call has a key only for an option that was
 * given.
 * @layer sdk
 */
import { settleOptions } from './settle-options'

describe('settleOptions', () => {
  it('has no key for an option that is absent, undefined or null', () => {
    // Scenario: an absent option and one set to undefined or null are the same, and none leaves a key.
    expect(Object.keys(settleOptions({}))).toEqual([])
    expect(
      Object.keys(
        settleOptions({ enabled: undefined, serviceName: null, unsafe: undefined } as never)
      )
    ).toEqual([])
  })

  it('has a key for each option that was given, with its value', () => {
    // Scenario: the control for the row above: what was given is copied.
    expect(
      settleOptions({ enabled: true, serviceName: 'api', extraRedactedQueryParams: ['a'] })
    ).toEqual({ enabled: true, serviceName: 'api', extraRedactedQueryParams: ['a'] })
  })
})
