/**
 * @fileoverview Tests the constants that the modules behind `start` fix when they load, each through a copy of the
 * module that the test itself loads: instrumentation names, signal exporters, detector names, sampler names, warning
 * texts, registry keys and the patterns that read a code, a package and a log value.
 * @layer sdk
 */
import type { ResourceDetector } from '@opentelemetry/resources'

const POLLUTED = 'BYMAX_TELEMETRY_REALM_POLLUTED'

beforeEach(() => {
  jest.resetModules()
})

afterEach(() => {
  jest.restoreAllMocks()
})

/** Collects what the modules hand to `process.emitWarning`, as `[text, type, code]`. */
function collectWarnings(): [string, unknown, unknown][] {
  const seen: [string, unknown, unknown][] = []
  jest.spyOn(process, 'emitWarning').mockImplementation(((
    text: string,
    options: { type: string; code: string }
  ): void => {
    seen.push([text, options.type, options.code])
  }) as never)
  return seen
}

/** The environment a start reads, with only the exporters the case sets. */
function environment(logs: string[]): never {
  return {
    sdkDisabled: false,
    serviceName: undefined,
    metricsExporters: ['otlp'],
    logsExporters: logs,
    batchSpanProcessor: {},
    oversizedTimers: [],
    resourceDetectors: undefined
  } as never
}

describe('the instrumentations that the assembly configures', () => {
  it('names each instrumentation, with its own setting, in the configuration it builds', async () => {
    // Scenario: every library setting sits under the exact package name of its instrumentation, read from a copy
    // loaded here, so a changed name answers with an empty entry and the setting is not found.
    const { buildInstrumentationConfig, planSignals } = await import('./assembly')
    const config = buildInstrumentationConfig({} as never, planSignals(environment(['otlp'])))
    const entry = (name: string): Record<string, unknown> =>
      config[name as keyof typeof config] as never
    expect(entry('@opentelemetry/instrumentation-fs')['enabled']).toBe(false)
    expect(entry('@opentelemetry/instrumentation-http')['redactedQueryParams']).toBeInstanceOf(
      Array
    )
    for (const name of ['pino', 'winston', 'bunyan']) {
      expect(entry(`@opentelemetry/instrumentation-${name}`)['disableLogSending']).toBe(false)
    }
    for (const name of ['redis', 'ioredis']) {
      expect(typeof entry(`@opentelemetry/instrumentation-${name}`)['dbStatementSerializer']).toBe(
        'function'
      )
    }
  })

  it('answers only for a name that starts with the instrumentation prefix', async () => {
    // Scenario: a name that is not an instrumentation (a plain word, `then`, `toJSON`) gets no answer, and a name
    // that is one gets an entry even when nothing was set for it.
    const { buildInstrumentationConfig, planSignals } = await import('./assembly')
    const config = buildInstrumentationConfig({} as never, planSignals(environment(['otlp'])))
    const read = (name: string): unknown => (config as Record<string, unknown>)[name]
    expect(read('plain')).toBeUndefined()
    expect(read('then')).toBeUndefined()
    expect(read('toJSON')).toBeUndefined()
    expect(read('@opentelemetry/instrumentation-unset')).toEqual({})
  })
})

describe('the exporters that send logs and the default service name', () => {
  it('sends logs for the otlp and console exporters only', async () => {
    // Scenario: the two names that set up a log export send logs, and none, a blank list and any other name do not.
    const { planSignals } = await import('./assembly')
    expect(planSignals(environment(['otlp'])).sendLogs).toBe(true)
    expect(planSignals(environment(['console'])).sendLogs).toBe(true)
    expect(planSignals(environment(['none'])).sendLogs).toBe(false)
    expect(planSignals(environment(['other'])).sendLogs).toBe(false)
  })

  it('names the service as the specification does when nobody gave a name', async () => {
    // Scenario: no name in the options or the environment; the resource carries the specification's default.
    const { buildResourceAttributes } = await import('./assembly')
    expect(buildResourceAttributes({} as never, environment([]))).toEqual({
      'service.name': 'unknown_service:node'
    })
  })
})

describe('the process warnings of the assembly', () => {
  it('gives the warning about a disabled redaction its type and code', async () => {
    // Scenario: an operator filters on the type and the code, so a disabled redaction is emitted under these two.
    const warnings = collectWarnings()
    const { warnAboutUnsafeOptions } = await import('./assembly')
    warnAboutUnsafeOptions({ unsafe: { disableUrlRedaction: true } })
    expect(warnings.map(([, type, code]) => [type, code])).toEqual([
      ['SecurityWarning', 'BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED']
    ])
  })

  it('gives the warning about ignored options its type and code', async () => {
    // Scenario: a call that has no effect on a running SDK is reported under its own type and code.
    const warnings = collectWarnings()
    const { warnAboutIgnoredOptions } = await import('./assembly')
    warnAboutIgnoredOptions({ enabled: false })
    expect(warnings.map(([, type, code]) => [type, code])).toEqual([
      ['Warning', 'BYMAX_TELEMETRY_OPTIONS_IGNORED']
    ])
  })

  it('writes every control, format and separator character of an operator value as an escape', async () => {
    // Scenario: one value holds a character of each category (`Cc`, `Cf`, `Zl`, `Zp`) between two plain letters,
    // and the plain letters stay as they are while the four are written out.
    const warnings = collectWarnings()
    const { warnAboutSamplerRatio } = await import('./assembly')
    const { registerWarningSink } = await import('./warning-sink')
    const remove = registerWarningSink(() => false)
    warnAboutSamplerRatio({ name: 'traceidratio', arg: 'x\u007f­  y' })
    remove()
    expect(warnings[0]?.[0]).toContain('"x\\u007f\\u00ad\\u2028\\u2029y"')
  })
})

describe('the code of a failure and the package it names', () => {
  it('names the code of a dropped batch', async () => {
    // Scenario: the code that a batch dropped for pollution carries is this one exactly.
    const { POLLUTED_CODE } = await import('./error-code')
    expect(POLLUTED_CODE).toBe(POLLUTED)
  })

  it('reads a code only when it is an upper-case token of 1 to 40 characters', async () => {
    // Scenario: a token passes, and a code with a lower-case start, a trailing space, a lower-case letter, one
    // character too many or no character at all is `UNKNOWN`.
    const { codeOf } = await import('./error-code')
    expect(codeOf({ code: 'AB_1' })).toBe('AB_1')
    expect(codeOf({ code: 'A' })).toBe('A')
    expect(codeOf({ code: 'A'.repeat(40) })).toBe('A'.repeat(40))
    expect(codeOf({ code: 'aBC' })).toBe('UNKNOWN')
    expect(codeOf({ code: 'AB c' })).toBe('UNKNOWN')
    expect(codeOf({ code: 'A'.repeat(41) })).toBe('UNKNOWN')
    expect(codeOf({ code: '' })).toBe('UNKNOWN')
  })

  it('names the whole OpenTelemetry package that a message mentions, and nothing else', async () => {
    // Scenario: the message names a package among other words; the description carries that package whole, and a
    // message that names none leaves the code alone.
    const { describeFailure } = await import('./error-code')
    expect(
      describeFailure({ code: 'ERR_X', message: 'Cannot find @opentelemetry/sdk-node from here' })
    ).toBe('code ERR_X, package @opentelemetry/sdk-node')
    expect(describeFailure({ code: 'ERR_X', message: 'no package here' })).toBe('code ERR_X')
  })
})

describe('the detectors that a name selects', () => {
  /** A detector for each name of the map, told apart by identity. */
  function detectorMap(): {
    env: ResourceDetector
    host: ResourceDetector
    os: ResourceDetector
    process: ResourceDetector
    serviceinstance: ResourceDetector
  } {
    const make = (): ResourceDetector => ({ detect: () => ({ attributes: {} }) as never })
    return {
      env: make(),
      host: make(),
      os: make(),
      process: make(),
      serviceinstance: make()
    }
  }
  const keepAll = { keepCommandLine: true, keepHostId: true }

  it('selects, for each name, the detectors that the specification and the SDK give it', async () => {
    // Scenario: each name in OTEL_NODE_RESOURCE_DETECTORS selects its detectors, the older names stay accepted and a
    // name nobody knows selects nothing.
    const { selectResourceDetectors } = await import('./resource-detectors')
    const d = detectorMap()
    const pick = (names: string[]): ResourceDetector[] => selectResourceDetectors(names, d, keepAll)
    expect(pick(['process'])).toEqual([d.process])
    expect(pick(['host'])).toEqual([d.host, d.os])
    expect(pick(['os'])).toEqual([d.os])
    expect(pick(['service'])).toEqual([d.serviceinstance, d.env])
    expect(pick(['serviceinstance'])).toEqual([d.serviceinstance])
    expect(pick(['env'])).toEqual([d.env])
    expect(pick(['unknown'])).toEqual([])
  })

  it('runs the SDK defaults when nothing is selected, and the whole table for `all`', async () => {
    // Scenario: unset selects the default detectors in the SDK's order, `all` selects its table in its order, and
    // `none` selects nothing.
    const { selectResourceDetectors } = await import('./resource-detectors')
    const d = detectorMap()
    expect(selectResourceDetectors(undefined, d, keepAll)).toEqual([
      d.serviceinstance,
      d.process,
      d.host,
      d.os,
      d.env
    ])
    expect(selectResourceDetectors(['all'], d, keepAll)).toEqual([
      d.host,
      d.os,
      d.serviceinstance,
      d.process,
      d.env
    ])
    expect(selectResourceDetectors(['none'], d, keepAll)).toEqual([])
  })
})

describe('the winston transport warning', () => {
  it('looks the packages up in order, from the file that the previous one gave, and warns with its text', async () => {
    // Scenario: winston and the bundle resolve, the instrumentation resolves from the bundle and the transport does
    // not resolve from the instrumentation; the lookups name the exact packages and the warning says what to do.
    const warnings = collectWarnings()
    const { warnAboutMissingWinstonTransport } = await import('./winston-transport')
    const asked: [string, string][] = []
    warnAboutMissingWinstonTransport(true, 'entry.js', (id, from) => {
      asked.push([id, from])
      return id === '@opentelemetry/winston-transport' ? undefined : `/at/${id}`
    })
    expect(asked).toEqual([
      ['winston', 'entry.js'],
      ['@opentelemetry/auto-instrumentations-node', 'entry.js'],
      ['@opentelemetry/instrumentation-winston', '/at/@opentelemetry/auto-instrumentations-node'],
      ['@opentelemetry/winston-transport', '/at/@opentelemetry/instrumentation-winston']
    ])
    expect(warnings).toEqual([
      [
        'Log forwarding is on and winston is installed, but @opentelemetry/winston-transport cannot be resolved from @opentelemetry/instrumentation-winston, so winston records will not be forwarded. Install @opentelemetry/winston-transport as a direct dependency of the application, or set instrumentations.sendLogs to false. Ignore this if the application never creates a winston logger, or if OTEL_LOGS_EXPORTER is none: nothing is forwarded then either way.',
        'Warning',
        'BYMAX_TELEMETRY_WINSTON_TRANSPORT_MISSING'
      ]
    ])
  })
})

describe('the sampler names of the environment', () => {
  it('reads the two ratio samplers with their argument, and no other name', async () => {
    // Scenario: only the two ratio samplers are ratio samplers.
    const { readRatioSampler } = await import('./environment')
    for (const name of ['traceidratio', 'parentbased_traceidratio']) {
      expect(
        readRatioSampler({ OTEL_TRACES_SAMPLER: name, OTEL_TRACES_SAMPLER_ARG: '0.5' })
      ).toEqual({ name, arg: '0.5' })
    }
    expect(readRatioSampler({ OTEL_TRACES_SAMPLER: 'always_on' })).toBeUndefined()
  })

  it('recognises each sampler name that was meant, and leaves an exact name alone', async () => {
    // Scenario: a name that differs only by case or spaces is a near miss of the exact name, for each of the six
    // names the SDK selects by, and the exact name is not a near miss of anything.
    const { readSamplerNearMiss } = await import('./environment')
    for (const name of [
      'always_on',
      'always_off',
      'parentbased_always_on',
      'parentbased_always_off',
      'traceidratio',
      'parentbased_traceidratio'
    ]) {
      expect(readSamplerNearMiss({ OTEL_TRACES_SAMPLER: ` ${name.toUpperCase()} ` })).toBe(name)
      expect(readSamplerNearMiss({ OTEL_TRACES_SAMPLER: name })).toBeUndefined()
    }
  })
})

describe('the registry keys of the failure count and the warning sink', () => {
  it('counts a failed export under its registry symbol', async () => {
    // Scenario: two copies of the library share one count through globalThis, under exactly this symbol.
    collectWarnings()
    const key = Symbol.for('@bymax-one/nest-telemetry/export-failures')
    Reflect.deleteProperty(globalThis, key)
    const { warnOnExportFailure } = await import('./export-failure')
    const exporter = warnOnExportFailure(
      {
        export: (_spans: readonly unknown[], done: (result: { code: number }) => void) =>
          done({ code: 1 })
      },
      'trace'
    )
    exporter.export([], () => undefined)
    expect(Reflect.get(globalThis, key)).toBe(1)
    Reflect.deleteProperty(globalThis, key)
  })

  it('publishes the warning sink under its registry symbol', async () => {
    // Scenario: a copy of the library that loads later finds the sink through this symbol alone.
    const { registerWarningSink } = await import('./warning-sink')
    const sink = (): boolean => true
    const remove = registerWarningSink(sink)
    expect(Reflect.get(globalThis, Symbol.for('@bymax-one/nest-telemetry/warning-sink'))).toBe(sink)
    remove()
  })
})

describe('the path an override error names', () => {
  it('names instrumentations.overrides[] when an entry key is __proto__', async () => {
    // Scenario: JSON.parse makes an own `__proto__` key; the refusal names the path of the override, not a key of the
    // host.
    const { settleOverrides } = await import('./option-kinds')
    let refused: unknown
    try {
      settleOverrides('instrumentations.overrides', JSON.parse('{"__proto__": {"a": 1}}'))
    } catch (error) {
      refused = error
    }
    expect(refused).toMatchObject({ option: 'instrumentations.overrides[]' })
  })
})
