/**
 * @fileoverview Tests the checks of the kind of an option: the error each one throws, word for word,
 * and the copies of a list and of a map.
 * @layer sdk
 */
import { runInNewContext } from 'node:vm'
import {
  MAX_OPTION_ENTRIES,
  TelemetryOptionError,
  requireBoolean,
  requireFunction,
  requireObject,
  readOwnOrClass,
  requireString,
  settleOverrides,
  settleRegExpList,
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
    expect(Object.hasOwn(error, 'cause')).toBe(false)
    const cause = new SyntaxError('inner')
    expect(new TelemetryOptionError('x', 'a boolean', cause).cause).toBe(cause)
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
    expect(settleOverrides('x', absent)).toBeUndefined()
  })
})

describe('settleStringList', () => {
  it('keeps an empty list that carries a property that is not an index, as 1.0.10 did', () => {
    // Scenario: a subclass with a field of its own and no entries is an empty list.
    class Tagged extends Array<string> {
      tag = 'config'
    }
    expect(settleStringList('x', new Tagged())).toEqual([])
  })

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

describe('settleOverrides', () => {
  it('copies the entries that are objects and drops the ones that are absent', () => {
    // Scenario: an entry that is null or undefined is the same as no entry.
    expect(settleOverrides('x', { a: { n: 1 }, b: null, c: undefined })).toEqual({ a: { n: 1 } })
  })

  it('accepts exactly the cap and refuses one more, in its own words', () => {
    // Scenario: the boundary of the cap, and the message of the refusal.
    const make = (count: number): Record<string, object> =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, {}]))
    expect(Object.keys(settleOverrides('x', make(MAX_OPTION_ENTRIES)) ?? {})).toHaveLength(
      MAX_OPTION_ENTRIES
    )
    expect(
      (thrown(() => settleOverrides('x', make(MAX_OPTION_ENTRIES + 1))) as Error).message
    ).toBe(
      `The x option must be an object of at most ${MAX_OPTION_ENTRIES} entries, so the start was refused.`
    )
  })
})

describe('settleOverrides, for the settings of an entry', () => {
  const settle = (entry: object): Record<string, Record<string, unknown>> | undefined =>
    settleOverrides('x', { pino: entry })

  it.each([
    ['enabled', 0],
    ['enabled', 'false'],
    ['disableLogSending', 0],
    ['disableLogSending', {}]
  ])('refuses %s that is %p, naming the path and not the instrumentation', (key, value) => {
    // Scenario: a switch that turns a signal on or off holds something that is not a boolean; a number
    // 0 is refused because the instrumentation would read it as a switch that is off.
    const error = thrown(() => settleOverrides('x', { secretName: { [key]: value } })) as Error
    expect(error.message).toBe(
      `The instrumentations.overrides[].${key} option must be a boolean, so the start was refused.`
    )
    expect(error.message).not.toContain('secretName')
  })

  it('refuses a redactedQueryParams that is not a list of strings', () => {
    // Scenario: the list of names to redact is a string, which would be spread into characters.
    expect(thrown(() => settle({ redactedQueryParams: 'abc' }))).toMatchObject({
      option: 'instrumentations.overrides[].redactedQueryParams'
    })
  })

  it('copies a list that is an Array subclass through its indexes, not through its iterator', () => {
    // Scenario: a subclass of Array whose iterator yields other names than its items hold; the copy is a
    // plain array of the items.
    class Sneaky extends Array<string> {
      override *[Symbol.iterator](): Generator<string> {
        yield 'from-the-iterator'
      }
    }
    const list = Sneaky.from(['a', 'b'])
    const copy = settle({ redactedQueryParams: list })?.['pino']?.['redactedQueryParams']
    expect(copy).toEqual(['a', 'b'])
    expect(Object.getPrototypeOf(copy)).toBe(Array.prototype)
  })

  it.each(['requestHook', 'ignoreIncomingRequestHook', 'responseHook'])(
    'refuses %s that is not a function, and keeps one that is',
    (key) => {
      // Scenario: a hook that runs host code is checked by its name ending in Hook.
      expect(thrown(() => settle({ [key]: 'not a function' }))).toMatchObject({
        option: 'instrumentations.overrides[].<a hook>'
      })
      const hook = (): boolean => true
      expect(settle({ [key]: hook })?.['pino']?.[key]).toBe(hook)
    }
  )

  it('keeps the settings of any other name, drops the absent ones, and reads each setting once', () => {
    // Scenario: a setting that is not checked passes through; an entry is copied, so a getter on it runs
    // once, at the copy, and never later.
    let reads = 0
    const entry = {
      enabled: true,
      other: { nested: 1 },
      gone: undefined,
      get disableLogSending() {
        reads += 1
        return false
      }
    }
    const copy = settle(entry)?.['pino']
    expect(copy).toEqual({ enabled: true, other: { nested: 1 }, disableLogSending: false })
    expect(Object.keys(copy ?? {})).not.toContain('gone')
    expect(copy).not.toBe(entry)
    expect(reads).toBe(1)
  })

  it('refuses an entry of more settings than the cap, and accepts one of exactly the cap', () => {
    // Scenario: the boundary of the cap on the settings of one entry.
    const make = (count: number): Record<string, number> =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, i]))
    expect(Object.keys(settle(make(MAX_OPTION_ENTRIES))?.['pino'] ?? {})).toHaveLength(
      MAX_OPTION_ENTRIES
    )
    expect((thrown(() => settle(make(MAX_OPTION_ENTRIES + 1))) as Error).message).toBe(
      `The instrumentations.overrides[] option must be an object of at most ${MAX_OPTION_ENTRIES} settings, so the start was refused.`
    )
  })
})

describe('settleOverrides, for a map or an entry whose keys sit on a prototype with no prototype', () => {
  const base = (): object =>
    Object.assign(Object.create(null) as object, { pino: { enabled: false } })
  const entryBase = (): object => Object.assign(Object.create(null) as object, { enabled: false })

  const plainParent = (): object => ({ pino: { enabled: false } })
  const plainEntryParent = (): object => ({ enabled: false })

  it.each([
    ['the map', () => Object.create(base()) as object, 'x'],
    [
      'the map, when its parent is an ordinary object',
      () => Object.create(plainParent()) as object,
      'x'
    ],
    [
      'an entry, when its parent is an ordinary object',
      () => ({ pino: Object.create(plainEntryParent()) as object }),
      'instrumentations.overrides[]'
    ],
    [
      'an entry of the map',
      () => ({ pino: Object.create(entryBase()) as object }),
      'instrumentations.overrides[]'
    ],
    [
      'a class chain ending in one',
      () => Object.create(Object.create(base()) as object) as object,
      'x'
    ]
  ])('refuses %s, so a setting is not dropped in silence', (_where, make, option) => {
    // Scenario: the keys of an own-keys copy miss a setting that only a null-prototype ancestor holds,
    // so the host's `enabled: false` would be lost; the start is refused with a fixed path instead.
    expect(thrown(() => settleOverrides('x', make()))).toMatchObject({
      option,
      message: `The ${option} option must be set on the object itself, not on a prototype, so the start was refused.`
    })
  })

  it('honours the same map and entry written as own keys', () => {
    // Scenario: the control for the rows above: the host's own keys are copied.
    expect(settleOverrides('x', { pino: { enabled: false } })).toEqual({ pino: { enabled: false } })
  })

  it('does not refuse a map whose chain ends in the root prototype of this realm', () => {
    // Scenario: the root prototype is where a pollution is planted and it is ignored, as for the options.
    const polluted = Object.create(Object.prototype) as object
    expect(settleOverrides('x', polluted)).toEqual({})
  })

  it('does not refuse a map that has an empty prototype with no prototype', () => {
    // Scenario: an ancestor with no keys holds no setting, so nothing is dropped.
    expect(settleOverrides('x', Object.create(Object.create(null) as object) as object)).toEqual({})
  })

  it('does not refuse a map whose chain ends in a root prototype that holds an enumerable name', () => {
    // Scenario: a pollution planted on the root prototype of this realm is enumerable, and it is the one
    // holder with no prototype that is ignored, so the map is read and nothing is refused.
    Object.defineProperty(Object.prototype, 'plantedName', {
      configurable: true,
      enumerable: true,
      value: 1
    })
    try {
      expect(settleOverrides('x', Object.create(Object.prototype) as object)).toEqual({})
    } finally {
      Reflect.deleteProperty(Object.prototype, 'plantedName')
    }
  })

  it('does not refuse a map whose parent holds only names that are not enumerable', () => {
    // Scenario: the methods of a class are not enumerable and hold no setting, so a class instance, whose
    // parent has a prototype of its own, is read as before.
    class Settings {
      own = { pino: { enabled: false } }
      method(): void {}
    }
    expect(settleOverrides('x', Object.assign(new Settings().own))).toEqual({
      pino: { enabled: false }
    })
    expect(() => settleOverrides('x', new Settings() as object)).not.toThrow()
  })

  it('accepts a map and an entry made in another realm, whose Object.prototype owns the accessor __proto__', () => {
    // Scenario: a plain object from vm.runInNewContext has that realm's root prototype as its parent, which owns
    // the non-enumerable accessor `__proto__`; it is the root of a realm and not a class, so it is not a setting.
    const map = runInNewContext('({ http: { enabled: false } })') as object
    expect(settleOverrides('x', map)).toEqual({ http: { enabled: false } })
  })

  it.each([
    [
      'an entry whose class holds a getter',
      (): object => {
        class Entry {
          get enabled(): boolean {
            return false
          }
        }
        return { http: new Entry() }
      },
      'instrumentations.overrides[]'
    ],
    [
      'a map whose class holds a getter',
      (): object => {
        class Map_ {
          get http(): object {
            return { enabled: false }
          }
        }
        return new Map_()
      },
      'x'
    ],
    [
      'an entry whose class holds a getter of a symbol name',
      (): object => {
        class Entry {
          get [Symbol.for('setting')](): boolean {
            return false
          }
        }
        return { http: new Entry() }
      },
      'instrumentations.overrides[]'
    ]
  ])('refuses %s, though the getter is not enumerable', (_where, make, option) => {
    // Scenario: a getter of a class is not enumerable, and the copy of own keys would drop the setting it answers
    // (`enabled: false`) in silence and leave the instrumentation on; a method is not a setting, a getter is.
    expect(thrown(() => settleOverrides('x', make()))).toMatchObject({
      option,
      message: `The ${option} option must be set on the object itself, not on a prototype, so the start was refused.`
    })
  })

  it('accepts a map with no prototype made in another realm', () => {
    // Scenario: Object.create(null) of another realm has no parent at all, so there is nothing to hold a setting.
    const map = runInNewContext(
      'Object.assign(Object.create(null), { http: { enabled: false } })'
    ) as object
    expect(settleOverrides('x', map)).toEqual({ http: { enabled: false } })
  })

  it.each([
    [
      'a class of another realm that holds a getter',
      'class Entry { get enabled() { return false } }; ({ http: new Entry() })',
      'instrumentations.overrides[]'
    ],
    [
      'the root prototype of another realm with an enumerable key planted on it',
      'Object.prototype.enabled = false; ({ http: {} })',
      'x'
    ]
  ])('refuses %s, as one of this realm', (_where, source, option) => {
    // Scenario: skipping the accessor `__proto__` of a foreign root must not hide a setting that a class of that
    // realm, or a key planted there, holds: they are refused as in this realm.
    expect(thrown(() => settleOverrides('x', runInNewContext(source) as object))).toMatchObject({
      option
    })
  })

  it('refuses a class whose prototype defines a getter named __proto__, which is not the accessor of a root', () => {
    // Scenario: only a holder with no prototype, the root of a realm, owns the accessor `__proto__` by right; a
    // class that defines one holds an inherited accessor like any other and is refused as one.
    class Entry {
      get ['__proto__'](): object {
        return { enabled: false }
      }
    }
    expect(thrown(() => settleOverrides('x', { http: new Entry() }))).toMatchObject({
      option: 'instrumentations.overrides[]'
    })
  })

  it('refuses a parent with no prototype that holds a getter of a setting, whatever the name', () => {
    // Scenario: only the name `__proto__` is skipped on a holder with no prototype; a getter named `enabled` there
    // is a setting that a copy of the own keys would drop in silence, so it is refused.
    const holder = Object.create(null, { enabled: { get: (): boolean => false } }) as object
    expect(
      thrown(() => settleOverrides('x', { http: Object.create(holder) as object }))
    ).toMatchObject({
      option: 'instrumentations.overrides[]'
    })
  })

  it('does not refuse a Proxy whose answer for its prototype is a holder of settings', () => {
    // Scenario: a Proxy is read for what it answers, so what its prototype trap says is not judged.
    const bare = Object.create(null, { pino: { value: {}, enumerable: true } }) as object
    const proxy = new Proxy({}, { getPrototypeOf: () => bare })
    expect(settleOverrides('x', proxy)).toEqual({})
  })

  it('walks at most the bound of prototypes when an ancestor answers differently the second time', () => {
    // Scenario: a chain that was short when it was checked and is endless when it is read again is
    // ended at the bound, so the start does not hang, and each hop reads the prototype twice at most.
    let calls = 0
    const loop: object = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          calls += 1
          return calls <= 1 ? null : loop
        }
      }
    )
    expect(settleOverrides('x', Object.create(loop) as object)).toEqual({})
    expect(calls).toBeLessThanOrEqual(1 + 2 * 100)
  })
})

describe('settleOverrides, for a key named __proto__', () => {
  it.each([
    ['a setting of an entry', '{"pino":{"__proto__":{"enabled":true}}}'],
    ['an entry of the map', '{"__proto__":{"enabled":true}}']
  ])('refuses %s, so it never becomes the prototype of a copy', (_where, json) => {
    // Scenario: JSON.parse makes `__proto__` an own key, which an assignment into a copy would turn
    // into the prototype; the start is refused with a fixed path.
    expect(() => settleOverrides('x', JSON.parse(json))).toThrow(
      'The instrumentations.overrides[] option must be free of a __proto__ key, so the start was refused.'
    )
  })

  it('does not refuse an ordinary key that merely contains the word', () => {
    // Scenario: the control for the row above.
    expect(settleOverrides('x', { proto: { __proto_: 1 } })).toEqual({ proto: { __proto_: 1 } })
  })
})

/** An object with exactly `count` prototypes, the last of them the root of the realm. */
function chainOf(count: number): object {
  let proto: object = Object.prototype
  for (let index = 1; index < count; index++) proto = Object.create(proto) as object
  return Object.create(proto) as object
}

/** An object whose `flag` is held by its prototype number `position`, the root of the realm further up. */
function flagHeldAt(position: number): object {
  const holder = Object.create(Object.prototype) as object
  Object.defineProperty(holder, 'flag', { value: true })
  let upper: object = holder
  for (let index = 1; index < position; index++) upper = Object.create(upper) as object
  return Object.create(upper) as object
}

describe('the longest chain of prototypes', () => {
  it('accepts 100 prototypes as the options and refuses 101', () => {
    // Scenario: the bound is exact: the 100th prototype is the last one followed.
    expect(requireObject('x', chainOf(100))).toBeDefined()
    expect(thrown(() => requireObject('x', chainOf(101)))).toBeInstanceOf(TelemetryOptionError)
  })

  it('reads a key held by the 100th prototype and not one held by the 101st', () => {
    // Scenario: the lookup stops at the same bound, and a key beyond it is not the host's.
    expect(readOwnOrClass(flagHeldAt(100), 'flag')).toBe(true)
    expect(readOwnOrClass(flagHeldAt(101), 'flag')).toBeUndefined()
  })
})

describe('requireObject, for a value of a kind that is not a plain object', () => {
  class Config {
    readonly enabled = true
  }

  it.each([
    ['a Map', new Map([['a', true]])],
    ['a Set', new Set(['a'])],
    ['a Date', new Date(0)],
    ['a RegExp', /a/],
    ['a Promise', Promise.resolve({})],
    ['a boxed boolean', new Boolean(false)]
  ])('refuses %s as the wrong kind, saying only that it must be an object', (_what, value) => {
    // Scenario: a stand-in that looks like an object but is not one reaches an option that must be one.
    expect((thrown(() => requireObject('x', value)) as Error).message).toBe(
      'The x option must be an object, so the start was refused.'
    )
  })

  it.each([
    ['a WeakMap', new WeakMap()],
    ['a WeakSet', new WeakSet()],
    ['an Error', new Error('x')],
    ['a typed array', new Uint8Array(1)],
    ['an ArrayBuffer', new ArrayBuffer(1)],
    ['a DataView', new DataView(new ArrayBuffer(1))],
    ['an iterator of a Map', new Map().keys()],
    ['a generator object', (function* gen() {})()]
  ])('refuses %s as the wrong kind, by the brand Node reports', (_what, value) => {
    // Scenario: an object of a brand Node reports cannot hold settings, so it is refused whatever its prototype.
    expect(thrown(() => requireObject('x', value))).toBeInstanceOf(TelemetryOptionError)
  })

  it('accepts an object whose chain ends in an object with no prototype, whatever it holds', () => {
    // Scenario: no property of a prototype is read to tell a root from data, so the end of a chain is the end
    // of a chain; only a chain that never ends or is too long is refused.
    const data = Object.assign(Object.create(null) as object, { a: 1 })
    const options = Object.create(data) as object
    expect(requireObject('x', options)).toBe(options)
  })

  it('refuses a stand-in whose chain never ends, instead of walking it for ever', () => {
    // Scenario: a Proxy that answers itself as its own prototype must end the walk, not hang the start.
    const cycle: object = new Proxy({}, { getPrototypeOf: () => cycle })
    expect(thrown(() => requireObject('x', cycle))).toBeInstanceOf(TelemetryOptionError)
    expect(readOwnOrClass(cycle, 'flag')).toBeUndefined()
  })

  it.each([
    ['a plain object', { a: 1 }],
    ['an object with no prototype', Object.create(null) as object],
    ['an object with a prototype of its own', Object.create({ inherited: true }) as object],
    ['an instance of a class', new Config()],
    ['a Proxy of a plain object', new Proxy({}, {})]
  ])('accepts %s', (_what, value) => {
    // Scenario: the control for the rows above: the kinds a host really passes are kept.
    expect(requireObject('x', value)).toBe(value)
  })
})

describe('settleRegExpList', () => {
  it('copies each expression, reading its source and its flags once', () => {
    // Scenario: the copy is a new expression with the same source and flags, and the host's own getters run once.
    let sourceReads = 0
    let flagsReads = 0
    const given = /^\/a$/gi
    Object.defineProperty(given, 'source', {
      get: () => {
        sourceReads += 1
        return '^\\/a$'
      }
    })
    Object.defineProperty(given, 'flags', {
      get: () => {
        flagsReads += 1
        return 'gi'
      }
    })
    const copy = settleRegExpList('x', [given])
    expect(copy?.[0]).not.toBe(given)
    expect(copy?.[0]?.source).toBe('^\\/a$')
    expect(copy?.[0]?.flags).toBe('gi')
    expect(sourceReads).toBe(1)
    expect(flagsReads).toBe(1)
  })

  it('copies by index, not through the iterator or the methods of an array subclass', () => {
    // Scenario: a subclass with an empty iterator and a map that returns nothing still yields what it holds.
    class Hollow extends Array<RegExp> {
      override map(): never[] {
        return []
      }
      override *[Symbol.iterator](): Generator<never> {
        // yields nothing
      }
    }
    const given = new Hollow()
    given.push(/^\/a$/)
    expect(settleRegExpList('x', given)).toHaveLength(1)
  })

  it.each([
    ['not an array', /a/, 'an array of regular expressions'],
    ['an entry that is not a RegExp', ['a'], 'an array of regular expressions'],
    [
      'an entry that only looks like one',
      [{ source: '.*', flags: '' }],
      'an array of regular expressions'
    ],
    [
      'an array over the cap',
      new Array<RegExp>(MAX_OPTION_ENTRIES + 1).fill(/a/),
      `an array of at most ${MAX_OPTION_ENTRIES} regular expressions`
    ]
  ])('refuses %s, saying %s', (_what, value, expected) => {
    // Scenario: each way the list can be wrong has its own words.
    expect((thrown(() => settleRegExpList('x', value)) as Error).message).toBe(
      `The x option must be ${expected}, so the start was refused.`
    )
  })

  it('keeps an empty list that carries a property that is not an index', () => {
    // Scenario: a subclass with a field of its own and no entries is an empty list, not a list that hides entries.
    class Tagged extends Array<RegExp> {
      tag = 'config'
    }
    expect(settleRegExpList('x', new Tagged())).toEqual([])
  })

  it('keeps an empty list whose extra key is a number too large to be an index', () => {
    // Scenario: 4294967295 is the first key that is not an array index, so it is metadata and not an entry.
    const list: RegExp[] = []
    Object.defineProperty(list, '4294967295', { value: 1, enumerable: true })
    expect(settleRegExpList('x', list)).toEqual([])
  })

  it('refuses an empty copy whose keys hold the largest array index', () => {
    // Scenario: 4294967294 is an array index, so a list that reads empty but has it hides an entry.
    const list = new Proxy([] as RegExp[], {
      ownKeys: () => ['4294967294'],
      getOwnPropertyDescriptor: () => ({ value: /a/, enumerable: true, configurable: true })
    })
    expect(thrown(() => settleRegExpList('x', list))).toBeInstanceOf(TelemetryOptionError)
  })

  it('refuses an empty copy of an input that holds entries', () => {
    // Scenario: a stand-in whose length reads 0 while it holds an expression is not read as an empty list.
    const list = new Proxy([/a/], {
      get: (target, key, receiver): unknown =>
        key === 'length' ? 0 : (Reflect.get(target, key, receiver) as unknown)
    })
    expect((thrown(() => settleRegExpList('x', list)) as Error).message).toBe(
      'The x option must be an array of regular expressions, so the start was refused.'
    )
  })

  it('refuses an expression whose flags cannot be built, with the library code and the original as the cause', () => {
    // Scenario: a RegExp whose own flags getter answers a string no expression accepts never surfaces a raw error.
    const bad = /a/
    Object.defineProperty(bad, 'flags', { get: () => 'zz' })
    const error = thrown(() => settleRegExpList('x', [bad])) as TelemetryOptionError
    expect(error).toBeInstanceOf(TelemetryOptionError)
    expect(error.code).toBe('BYMAX_TELEMETRY_OPTION_INVALID')
    expect(error.message).toBe(
      'The x option must be an array of regular expressions, so the start was refused.'
    )
    expect(error.cause).toBeInstanceOf(SyntaxError)
  })

  it('keeps an empty list empty', () => {
    // Scenario: the control: an empty list is a valid list that matches nothing.
    expect(settleRegExpList('x', [])).toEqual([])
  })
})
