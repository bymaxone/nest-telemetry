/**
 * @fileoverview Tests the checks of the kind of an option: the error each one throws, word for word,
 * and the copies of a list and of a map.
 * @layer sdk
 */
import {
  MAX_OPTION_ENTRIES,
  TelemetryOptionError,
  requireBoolean,
  requireFunction,
  requireObject,
  requireString,
  settleObjectMap,
  settleStringList
} from './option-kinds'

/** The error a call throws, or `undefined`. */
function thrown(call: () => unknown): unknown {
  try {
    call()
    return undefined
  } catch (error) {
    return error
  }
}

describe('TelemetryOptionError', () => {
  it('carries its name, its code, the option and a message that names what the option must be', () => {
    // Scenario: the error a host catches; none of its fields holds a value the host passed.
    const error = new TelemetryOptionError('unsafe.exportHostId', 'a boolean')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('TelemetryOptionError')
    expect(error.code).toBe('BYMAX_TELEMETRY_OPTION_INVALID')
    expect(error.option).toBe('unsafe.exportHostId')
    expect(error.message).toBe(
      'The unsafe.exportHostId option must be a boolean, so the start was refused.'
    )
  })
})

describe('the checks of one option', () => {
  it.each([
    ['requireBoolean', (value: unknown) => requireBoolean('x', value), 'a boolean', 'yes'],
    ['requireString', (value: unknown) => requireString('x', value), 'a string', 5],
    ['requireFunction', (value: unknown) => requireFunction('x', value), 'a function', {}],
    ['requireObject', (value: unknown) => requireObject('x', value), 'an object', []]
  ])('%s refuses another kind with a message that names %s', (_name, check, expected, wrong) => {
    // Scenario: each check refuses a value of another kind, and says what the option must be.
    expect((thrown(() => check(wrong)) as Error).message).toBe(
      `The x option must be ${expected}, so the start was refused.`
    )
  })

  it.each([undefined, null])('treats %p as not given', (absent) => {
    // Scenario: the control for the rows above: an absent value is not an error.
    expect(requireBoolean('x', absent)).toBeUndefined()
    expect(requireString('x', absent)).toBeUndefined()
    expect(requireFunction('x', absent)).toBeUndefined()
    expect(requireObject('x', absent)).toBeUndefined()
    expect(settleStringList('x', absent)).toBeUndefined()
    expect(settleObjectMap('x', absent)).toBeUndefined()
  })
})

describe('settleStringList', () => {
  it('copies the strings in order, and an empty list stays empty', () => {
    // Scenario: the copy is exactly the list that was given, not the list plus anything.
    const given = ['a', 'b']
    const copy = settleStringList('x', given)
    expect(copy).toEqual(['a', 'b'])
    expect(copy).not.toBe(given)
    expect(settleStringList('x', [])).toEqual([])
  })

  it.each([
    ['not an array', 'abc', 'an array of strings'],
    ['an array with an item that is not a string', ['a', 1], 'an array of strings'],
    [
      'an array over the cap',
      new Array<string>(MAX_OPTION_ENTRIES + 1).fill('a'),
      `an array of at most ${MAX_OPTION_ENTRIES} strings`
    ]
  ])('refuses %s, saying %s', (_what, value, expected) => {
    // Scenario: each way a list can be wrong has its own words.
    expect((thrown(() => settleStringList('x', value)) as Error).message).toBe(
      `The x option must be ${expected}, so the start was refused.`
    )
  })

  it('refuses a length that is not a count, with the words for an array of strings', () => {
    // Scenario: a stand-in for an array whose length reads as a fraction.
    const list = new Proxy(['a'], {
      get: (target, key, receiver): unknown =>
        key === 'length' ? 1.5 : (Reflect.get(target, key, receiver) as unknown)
    })
    expect((thrown(() => settleStringList('x', list)) as Error).message).toBe(
      'The x option must be an array of strings, so the start was refused.'
    )
  })

  it('accepts a list of exactly the cap', () => {
    // Scenario: the boundary of the cap: the cap itself is allowed.
    const given = new Array<string>(MAX_OPTION_ENTRIES).fill('a')
    expect(settleStringList('x', given)).toHaveLength(MAX_OPTION_ENTRIES)
  })
})

describe('settleObjectMap', () => {
  it('copies the entries that are objects and drops the ones that are absent', () => {
    // Scenario: an entry that is null or undefined is the same as no entry.
    expect(settleObjectMap('x', { a: { n: 1 }, b: null, c: undefined })).toEqual({ a: { n: 1 } })
  })

  it('accepts exactly the cap and refuses one more, in its own words', () => {
    // Scenario: the boundary of the cap, and the message of the refusal.
    const make = (count: number): Record<string, object> =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, {}]))
    expect(Object.keys(settleObjectMap('x', make(MAX_OPTION_ENTRIES)) ?? {})).toHaveLength(
      MAX_OPTION_ENTRIES
    )
    expect(
      (thrown(() => settleObjectMap('x', make(MAX_OPTION_ENTRIES + 1))) as Error).message
    ).toBe(
      `The x option must be an object of at most ${MAX_OPTION_ENTRIES} entries, so the start was refused.`
    )
  })
})
