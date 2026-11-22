/**
 * @fileoverview Tests the protections against a name that only the root prototype of the realm
 * holds, beyond the options themselves: the placeholders on the process environment while the SDK is
 * built, the configuration handed to the instrumentations, a Proxy as a group of options, and an
 * options object that is not an object of settings.
 * @layer sdk
 */
import { runInNewContext } from 'node:vm'

import { buildInstrumentationConfig, severFromRootPrototype } from './assembly'
import type { InstrumentationInputs } from './assembly'
import { withoutPlantedVariables } from './environment'
import { readOwnOrClass, settleOverrides, settleStringList } from './option-kinds'
import { settleOptions } from './settle-options'
import type { TelemetryOptions } from './types'

const HTTP = '@opentelemetry/instrumentation-http'
const FS = '@opentelemetry/instrumentation-fs'
const NAME = 'OTEL_PLANTED_FOR_THE_TEST'

/** Plants a name on the root prototype while `run` executes. */
function planted<T>(name: string, value: unknown, run: () => T): T {
  Object.defineProperty(Object.prototype, name, { value, configurable: true, writable: true })
  try {
    return run()
  } finally {
    delete (Object.prototype as unknown as Record<string, unknown>)[name]
  }
}

describe('withoutPlantedVariables', () => {
  it('makes a planted OTEL name an own empty variable for the step only', () => {
    // Scenario: during the step the planted name reads as empty on the process environment, which
    // OpenTelemetry treats as unset, and afterwards it is not there as an own variable any more.
    planted(NAME, 'planted', () => {
      const seen = withoutPlantedVariables(() => [
        process.env[NAME],
        Object.hasOwn(process.env, NAME)
      ])
      expect(seen).toEqual(['', true])
      expect(Object.hasOwn(process.env, NAME)).toBe(false)
    })
  })

  it('returns what the step returns and removes the placeholders when it throws', () => {
    // Scenario: the cleanup does not depend on the step finishing.
    planted(NAME, 'planted', () => {
      expect(withoutPlantedVariables(() => 7)).toBe(7)
      expect(() =>
        withoutPlantedVariables(() => {
          throw new Error('step failed')
        })
      ).toThrow('step failed')
      expect(Object.hasOwn(process.env, NAME)).toBe(false)
    })
  })

  it('leaves a variable the process environment has, and a name that is not an OTEL one', () => {
    // Scenario: only a planted OTEL name is shadowed; an own variable keeps its value and is kept.
    process.env[NAME] = 'real'
    try {
      planted(NAME, 'planted', () => {
        expect(withoutPlantedVariables(() => process.env[NAME])).toBe('real')
      })
      expect(process.env[NAME]).toBe('real')
    } finally {
      delete process.env[NAME]
    }
    planted('NOT_AN_OTEL_NAME', 'planted', () => {
      withoutPlantedVariables(() =>
        expect(Object.hasOwn(process.env, 'NOT_AN_OTEL_NAME')).toBe(false)
      )
    })
  })
})

describe('the configuration handed to the instrumentations', () => {
  const inputs = { instrumentations: { fs: false } } as unknown as InstrumentationInputs
  const signals = { sendLogs: false } as never

  it('has no prototype, in the map and in every entry, so a planted name is not found', () => {
    // Scenario: a name the root prototype holds is neither an instrumentation of the host nor a setting.
    planted(FS, { enabled: true }, () => {
      planted('@opentelemetry/instrumentation-pg', { enabled: true }, () => {
        const config = buildInstrumentationConfig(inputs, signals)
        expect(Object.getPrototypeOf(config)).toBeNull()
        expect(config[FS]).toEqual({ enabled: false })
        expect(config['@opentelemetry/instrumentation-pg' as keyof typeof config]).toEqual({})
        expect(
          Object.getPrototypeOf(config['@opentelemetry/instrumentation-pg' as keyof typeof config])
        ).toBeNull()
        expect(Object.keys(config)).not.toContain('@opentelemetry/instrumentation-pg')
        for (const entry of Object.values(config)) {
          expect(Object.getPrototypeOf(entry)).toBeNull()
        }
      })
    })
  })

  it('answers only for an instrumentation name, so nothing else sees an entry', () => {
    // Scenario: a symbol, `then`, `toJSON` and any name that is not an instrumentation answer nothing, and
    // asking never adds a name to the map: awaiting or serialising it behaves as a plain object does.
    const config = buildInstrumentationConfig(inputs, signals) as unknown as Record<
      string | symbol,
      unknown
    >
    const before = Object.keys(config)
    for (const name of [
      Symbol.iterator,
      Symbol.toPrimitive,
      'then',
      'toJSON',
      'constructor',
      'x'
    ]) {
      expect(config[name]).toBeUndefined()
    }
    expect(config['@opentelemetry/instrumentation-pg']).toEqual({})
    expect('@opentelemetry/instrumentation-pg' in config).toBe(false)
    expect(Object.keys(config)).toEqual(before)
    expect(Object.entries(config)).toHaveLength(before.length)
    expect(JSON.parse(JSON.stringify(config))).toHaveProperty([FS])
  })

  it.each([
    [HTTP, ['headersToSpanAttributes']],
    ['@opentelemetry/instrumentation-grpc', ['metadataToSpanAttributes']],
    ['@opentelemetry/instrumentation-aws-lambda', ['lambdaHandler']],
    [
      '@opentelemetry/instrumentation-redis',
      ['dbStatementSerializer', 'responseHook', 'requireParentSpan']
    ]
  ])('gives %s an own, undefined, value for what it reads while it is built', (name, keys) => {
    // Scenario: an instrumentation reads these settings in its constructor, before the configuration is
    // cut from the root prototype, so each is an own key that is undefined and a planted one is not found.
    const entry = buildInstrumentationConfig(
      { unsafe: { disableRedisArgumentRedaction: true } } as never,
      signals
    )[name as keyof ReturnType<typeof buildInstrumentationConfig>] as Record<string, unknown>
    for (const key of keys) {
      expect(Object.hasOwn(entry, key)).toBe(true)
      expect(entry[key]).toBeUndefined()
    }
  })

  it('gives the HTTP instrumentation its own, undefined, header capture, unless the host set one', () => {
    // Scenario: the HTTP instrumentation reads the option when it is built, so an own key shadows a planted one.
    const own = buildInstrumentationConfig(inputs, signals)[HTTP] as Record<string, unknown>
    expect(Object.hasOwn(own, 'headersToSpanAttributes')).toBe(true)
    expect(own['headersToSpanAttributes']).toBeUndefined()
    const host = { server: { requestHeaders: ['x-request-id'] } }
    const set = buildInstrumentationConfig(
      {
        instrumentations: { overrides: { [HTTP]: { headersToSpanAttributes: host } } }
      } as unknown as InstrumentationInputs,
      signals
    )[HTTP] as Record<string, unknown>
    expect(set['headersToSpanAttributes']).toEqual(host)
  })
})

describe('severFromRootPrototype', () => {
  it('cuts the configuration of an instrumentation from the root prototype and returns it', () => {
    // Scenario: a hook a polluted realm planted is not found by an instrumentation at the time of a request.
    const instrumentation = {
      config: { enabled: true },
      getConfig() {
        return this.config
      }
    }
    planted(
      'requestHook',
      () => 'planted',
      () => {
        expect(
          (instrumentation.getConfig() as Record<string, unknown>)['requestHook']
        ).toBeDefined()
        expect(severFromRootPrototype(instrumentation)).toBe(instrumentation)
        expect(
          (instrumentation.getConfig() as Record<string, unknown>)['requestHook']
        ).toBeUndefined()
        expect(instrumentation.getConfig().enabled).toBe(true)
      }
    )
  })
})

describe('a Proxy as a group of options', () => {
  it('is read through what it answers, whatever traps it has', () => {
    // Scenario: a Proxy with only a get trap has no own key to find; its answer is the host's value.
    const group = new Proxy({}, { get: (_target, key) => (key === 'flag' ? true : undefined) })
    expect(readOwnOrClass(group, 'flag')).toBe(true)
    expect(readOwnOrClass(group, 'other')).toBeUndefined()
  })

  it('is read through for a whole start option too', () => {
    // Scenario: the options of a call can be a Proxy of the host's own object.
    const options = new Proxy({ serviceName: 'api' }, {}) as TelemetryOptions
    expect(settleOptions(options)).toEqual(expect.objectContaining({ serviceName: 'api' }))
    const getOnly = new Proxy(
      {},
      { get: (_t, key) => (key === 'serviceName' ? 'api' : undefined) }
    ) as TelemetryOptions
    expect(settleOptions(getOnly)).toEqual(expect.objectContaining({ serviceName: 'api' }))
  })
})

describe('the options object of a call', () => {
  it.each([
    ['a function', (): void => undefined],
    ['an array', []],
    ['a number', 1],
    ['a string', 'text']
  ])('is refused when it is %s', (_label, value) => {
    // Scenario: the options of the call must be an object of settings, like each option that is one.
    expect(() => settleOptions(value as TelemetryOptions)).toThrow(
      expect.objectContaining({ code: 'BYMAX_TELEMETRY_OPTION_INVALID', option: 'options' })
    )
  })

  it('is read when it is absent, null or an empty object', () => {
    // Scenario: the control: no options is not an error.
    expect(settleOptions({})).toEqual({})
    expect(settleOptions(null as never)).toEqual({})
  })
})

describe('a list option with a hole', () => {
  it('is refused for a hole, whatever the root prototype holds at that index', () => {
    // Scenario: a hole in the host's sparse list is a missing entry, which a list of strings refuses; a data
    // value planted at index 0 on the root prototype must not fill it in.
    const sparse: unknown[] = []
    sparse[1] = 'session'
    planted('0', 'planted', () => {
      expect(() => settleStringList('extraRedactedQueryParams', sparse)).toThrow(
        expect.objectContaining({ code: 'BYMAX_TELEMETRY_OPTION_INVALID' })
      )
    })
    expect(() => settleStringList('extraRedactedQueryParams', sparse)).toThrow(
      expect.objectContaining({ code: 'BYMAX_TELEMETRY_OPTION_INVALID' })
    )
  })
})

describe('a setting that the host nests in an override', () => {
  const HOST = '@opentelemetry/instrumentation-http'
  const settle = (setting: unknown): Record<string, unknown> =>
    (
      settleOverrides('overrides', { [HOST]: { headersToSpanAttributes: setting } }) as Record<
        string,
        Record<string, unknown>
      >
    )[HOST] as Record<string, unknown>

  it('is copied with no prototype, objects and lists to any depth, so a planted key is not found', () => {
    // Scenario: `server: {}` the host wrote must not answer a `requestHeaders` the root prototype holds.
    planted('requestHeaders', ['authorization'], () => {
      const copy = settle({ server: {}, client: { requestHeaders: ['x-id'] } }) as {
        headersToSpanAttributes: {
          server: Record<string, unknown>
          client: Record<string, unknown>
        }
      }
      const { server, client } = copy.headersToSpanAttributes
      expect(Object.getPrototypeOf(server)).toBeNull()
      expect(server['requestHeaders']).toBeUndefined()
      expect(client['requestHeaders']).toEqual(['x-id'])
    })
    const nested = settle({ rules: [{ a: 1 }, [{ b: 2 }]] }) as {
      headersToSpanAttributes: { rules: [Record<string, number>, Record<string, number>[]] }
    }
    const [first, second] = nested.headersToSpanAttributes.rules
    expect(Object.getPrototypeOf(first)).toBeNull()
    expect(Object.getPrototypeOf((second as Record<string, number>[])[0])).toBeNull()
  })

  it('copies a plain object of another realm too, and fills no hole of a list from a prototype', () => {
    // Scenario: an object made in a vm context has the root prototype of that context, which can hold a
    // planted key; and a hole in a sparse list is a missing member, not whatever the root holds at its index.
    const foreign = runInNewContext(
      'Object.prototype.requestHeaders = ["authorization"]; ({ server: {}, client: {} })'
    ) as object
    const copy = settle(foreign) as {
      headersToSpanAttributes: { server: Record<string, unknown> }
    }
    expect(Object.getPrototypeOf(copy.headersToSpanAttributes.server)).toBeNull()
    expect(copy.headersToSpanAttributes.server['requestHeaders']).toBeUndefined()
    planted('0', 'PLANTED', () => {
      const sparse: unknown[] = []
      sparse[1] = 'host'
      const list = (settle({ list: sparse }) as { headersToSpanAttributes: { list: unknown[] } })
        .headersToSpanAttributes.list
      expect(list).toEqual([undefined, 'host'])
    })
  })

  it('passes a function, a class instance, a Date, a Map and a Proxy through as the host wrote them', () => {
    // Scenario: only a plain object and a list are copied; anything else is the host's.
    class Agent {}
    const kept = [new Agent(), new Date(0), new Map(), new Proxy({}, {}), (): void => undefined]
    const copy = settle({ kept }) as { headersToSpanAttributes: { kept: unknown[] } }
    kept.forEach((value, index) => expect(copy.headersToSpanAttributes.kept[index]).toBe(value))
  })

  it('copies a list whole when the root prototype holds an iterator', () => {
    // Scenario: a planted Symbol.iterator on the root prototype must not decide how many members are
    // copied, which would drop an entry of a nested list of an override setting.
    const iterator = function* (): Generator<number> {
      yield 0
    }
    planted(Symbol.iterator as unknown as string, iterator, () => {
      const copy = settle({ list: ['session', 'password'] }) as {
        headersToSpanAttributes: { list: string[] }
      }
      expect(copy.headersToSpanAttributes.list).toEqual(['session', 'password'])
    })
  })

  it('copies an object with no prototype, a list subclass and a shared member, and reads a getter once', () => {
    // Scenario: the rest of the cases of the copy: what is copied (every kind of plain object and list), how
    // often a getter runs, that a shared member is copied for each place it sits, and what is not copied.
    class Rows extends Array<number> {}
    const bare = Object.assign(Object.create(null) as object, { a: 1 })
    let reads = 0
    const getter = {
      get once(): number {
        reads += 1
        return 1
      }
    }
    const shared = { x: 1 }
    const symbol = Symbol('hidden')
    const rows = Rows.from([1, 2])
    const copy = settle({
      bare,
      rows,
      getter,
      twice: [shared, shared],
      [symbol]: 'dropped'
    }) as { headersToSpanAttributes: Record<string | symbol, unknown> }
    const out = copy.headersToSpanAttributes
    expect(Object.getPrototypeOf(out['bare'])).toBeNull()
    expect(
      Array.isArray(out['rows']) && Object.getPrototypeOf(out['rows']) === Array.prototype
    ).toBe(true)
    expect(reads).toBe(1)
    const [first, second] = out['twice'] as object[]
    expect(first).not.toBe(second)
    expect(out[symbol]).toBeUndefined()
    const kept = [new Uint8Array(1), new Set(), /x/, new Error('x'), Object(1)]
    const same = settle({ kept }) as { headersToSpanAttributes: { kept: unknown[] } }
    kept.forEach((value, index) => expect(same.headersToSpanAttributes.kept[index]).toBe(value))
  })

  it('refuses at exactly the bounds and accepts one inside them, with the words of each refusal', () => {
    // Scenario: 16 levels, 10,000 objects and lists in all, and 1000 members to a list or an object are the
    // last allowed values; one more of each is refused with the words that say which bound it was.
    const chain = (levels: number, wrap: (inner: unknown) => unknown): unknown => {
      let inner: unknown = {}
      for (let level = 0; level < levels; level++) inner = wrap(inner)
      return inner
    }
    const refused = (setting: unknown): Error =>
      (() => {
        try {
          settle(setting)
        } catch (error) {
          return error as Error
        }
        return new Error('accepted')
      })()
    expect(() => settle(chain(16, (inner) => ({ next: inner })))).not.toThrow()
    expect(() => settle(chain(16, (inner) => [inner]))).not.toThrow()
    expect(refused(chain(17, (inner) => ({ next: inner }))).message).toContain(
      'nested at most 16 levels deep'
    )
    expect(refused(chain(17, (inner) => [inner])).message).toContain(
      'nested at most 16 levels deep'
    )
    const total = (extra: number): unknown =>
      Array.from({ length: 10 }, () => Array.from({ length: 990 }, () => ({}))).concat(
        Array.from({ length: 89 + extra }, () => ({})) as never
      )
    expect(() => settle(total(0))).not.toThrow()
    expect(refused(total(1)).message).toContain('nested at most 16 levels deep')
    const members = (count: number): number[] => Array.from({ length: count }, () => 0)
    const keys = (count: number): object =>
      Object.fromEntries(members(count).map((_zero, index) => [`k${index}`, 0]))
    expect(() => settle({ list: members(1000) })).not.toThrow()
    expect(() => settle(keys(1000))).not.toThrow()
    expect(refused({ list: members(1001) }).message).toContain('a list of at most 1000 entries')
    expect(refused(keys(1001)).message).toContain('an object of at most 1000 entries')
  })

  it('copies a list to exactly its own length, whatever the host list holds past it', () => {
    // Scenario: the copy has the host's length and no member more, so a redaction list keeps its size.
    const copy = settle({ list: ['a', 'b', 'c'] }) as {
      headersToSpanAttributes: { list: string[] }
    }
    expect(copy.headersToSpanAttributes.list).toHaveLength(3)
    expect(Object.keys(copy.headersToSpanAttributes.list)).toEqual(['0', '1', '2'])
    expect(Object.keys(settle({ nested: [[1]] }).headersToSpanAttributes as object)).toEqual([
      'nested'
    ])
  })

  it('is refused when it nests too deep, holds too many values, has a long list or object or a __proto__ key', () => {
    // Scenario: the copy is bounded, and a cycle in the host's object ends in a refusal and not a hang.
    const deep: Record<string, unknown> = {}
    let at = deep
    for (let level = 0; level < 20; level++) at = at['next'] = {}
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle
    const wide = { list: Array.from({ length: 1001 }, () => 0) }
    const broad = Object.fromEntries(Array.from({ length: 1001 }, (_v, index) => [`k${index}`, 0]))
    const many = {
      groups: Array.from({ length: 20 }, () => Array.from({ length: 600 }, () => ({})))
    }
    const proto = JSON.parse('{"a":{"__proto__":1}}') as unknown
    for (const setting of [deep, cycle, wide, broad, many, proto]) {
      expect(() => settle(setting)).toThrow(
        expect.objectContaining({ code: 'BYMAX_TELEMETRY_OPTION_INVALID' })
      )
    }
  })
})
