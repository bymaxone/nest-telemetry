/**
 * @fileoverview Tests the protections against a name that only the root prototype of the realm
 * holds, beyond the options themselves: the placeholders on the process environment while the SDK is
 * built, the configuration handed to the instrumentations, a Proxy as a group of options, and an
 * options object that is not an object of settings.
 * @layer sdk
 */
import { buildInstrumentationConfig, severFromRootPrototype } from './assembly'
import type { InstrumentationInputs } from './assembly'
import { withoutPlantedVariables } from './environment'
import { readOwnOrClass } from './option-kinds'
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
