/**
 * @fileoverview Pins that an option key holding `undefined` or `null` is the same as no key, for every
 * option that has a default: each case resolves the option both ways and compares it with the default.
 * @layer sdk
 */
import {
  buildInstrumentationConfig,
  buildResourceAttributes,
  planSignals,
  warnAboutIgnoredOptions,
  warnAboutMissingServiceName,
  warnAboutUnsafeOptions
} from './assembly'
import { readTelemetryEnvironment } from './environment'
import type { TelemetryOptions } from './types'

const FS = '@opentelemetry/instrumentation-fs'
const HTTP = '@opentelemetry/instrumentation-http'
const PINO = '@opentelemetry/instrumentation-pino'

const ABSENT = [undefined, null] as const

const env = readTelemetryEnvironment({})
const signals = planSignals(readTelemetryEnvironment({ OTEL_LOGS_EXPORTER: 'otlp' }))

/** Options as a JavaScript caller can pass them, where a key may hold `null`. */
function loose(options: object): TelemetryOptions {
  return options as TelemetryOptions
}

describe('the instrumentation config, for an absent option', () => {
  const baseline = buildInstrumentationConfig({}, signals)

  it.each(
    ABSENT.flatMap((absent) => [
      ['instrumentations', { instrumentations: absent }],
      ['instrumentations.fs', { instrumentations: { fs: absent } }],
      ['instrumentations.sendLogs', { instrumentations: { sendLogs: absent } }],
      ['instrumentations.overrides', { instrumentations: { overrides: absent } }],
      ['an override entry', { instrumentations: { overrides: { [FS]: absent } } }],
      [
        'an override key of the file-system instrumentation',
        { instrumentations: { overrides: { [FS]: { enabled: absent } } } }
      ],
      [
        'an override key of a logging instrumentation',
        { instrumentations: { overrides: { [PINO]: { disableLogSending: absent } } } }
      ],
      ['extraRedactedQueryParams', { extraRedactedQueryParams: absent }],
      ['ignoreIncomingRequest', { ignoreIncomingRequest: absent }],
      ['unsafe', { unsafe: absent }],
      [
        'unsafe.disableRedisArgumentRedaction',
        { unsafe: { disableRedisArgumentRedaction: absent } }
      ]
    ])
  )('keeps the default when %s is absent (%#)', (_name, options) => {
    // Scenario: a host that builds its options from a config object passes `undefined` or `null`
    // for what it does not set; that must not replace a default the library applies.
    expect(buildInstrumentationConfig(loose(options), signals)).toEqual(baseline)
  })

  it('applies the value of the same keys when it is given (the control)', () => {
    // Scenario: the cases above would pass for an option that was ignored altogether, so the same
    // keys with a value must change the result.
    const config = buildInstrumentationConfig(
      loose({
        instrumentations: {
          fs: true,
          sendLogs: false,
          overrides: { [HTTP]: { requireParentforIncomingSpans: true } }
        },
        extraRedactedQueryParams: ['sid'],
        ignoreIncomingRequest: () => true
      }),
      signals
    )
    expect(config).not.toEqual(baseline)
    expect(config[FS]).toEqual({ enabled: true })
    expect(config[PINO]).toEqual({ disableLogSending: true })
    expect(config[HTTP]).toMatchObject({ requireParentforIncomingSpans: true })
  })
})

describe('the resource, for an absent option', () => {
  it.each(ABSENT)('takes the unknown service name and no version when both are %p', (absent) => {
    // Scenario: a service name or version read from a config that does not have it.
    expect(
      buildResourceAttributes(loose({ serviceName: absent, serviceVersion: absent }), env)
    ).toEqual(buildResourceAttributes({}, env))
  })
})

describe('the warnings, for an absent option', () => {
  let emitWarning: jest.SpyInstance

  beforeEach(() => {
    emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  })

  it.each(ABSENT)('names the missing service name when serviceName is %p', (absent) => {
    // Scenario: an absent name is a missing one, the same as no key.
    warnAboutMissingServiceName(loose({ serviceName: absent }), env)
    expect(emitWarning).toHaveBeenCalledTimes(1)
  })

  it.each(
    ABSENT.flatMap((absent) => [
      ['unsafe', { unsafe: absent }],
      ['unsafe.disableUrlRedaction', { unsafe: { disableUrlRedaction: absent } }],
      ['unsafe.exportProcessCommandArgs', { unsafe: { exportProcessCommandArgs: absent } }],
      ['unsafe.exportHostId', { unsafe: { exportHostId: absent } }],
      [
        'unsafe.disableRedisArgumentRedaction',
        { unsafe: { disableRedisArgumentRedaction: absent } }
      ]
    ])
  )('does not say a redaction was turned off when %s is absent (%#)', (_name, options) => {
    // Scenario: only `true` turns a redaction off, and an absent key is not `true`.
    warnAboutUnsafeOptions(loose(options))
    expect(emitWarning).not.toHaveBeenCalled()
  })

  it.each(ABSENT)('treats a call whose every option is %p as having passed none', (absent) => {
    // Scenario: a repeated start with options read from an empty config is a bare repeated start,
    // which stays silent.
    warnAboutIgnoredOptions(
      loose({ serviceName: absent, instrumentations: absent, unsafe: absent, enabled: absent })
    )
    expect(emitWarning).not.toHaveBeenCalled()
  })

  it('says the options were ignored when one of them has a value (the control)', () => {
    // Scenario: the case above would pass for a check that never speaks.
    warnAboutIgnoredOptions(loose({ serviceName: 'api', instrumentations: null }))
    expect(emitWarning).toHaveBeenCalledTimes(1)
  })
})

describe('options given as a class instance', () => {
  /** A group whose values sit behind prototype getters, as a config class has them. */
  class InstrumentationGroup {
    constructor(private readonly given: Record<string, unknown>) {}
    get fs(): unknown {
      return this.given['fs']
    }
    get sendLogs(): unknown {
      return this.given['sendLogs']
    }
  }

  class UnsafeGroup {
    constructor(private readonly given: Record<string, unknown>) {}
    get disableUrlRedaction(): unknown {
      return this.given['disableUrlRedaction']
    }
  }

  class CallOptions {
    constructor(private readonly given: Record<string, unknown>) {}
    get serviceName(): unknown {
      return this.given['serviceName']
    }
    get instrumentations(): unknown {
      return this.given['instrumentations']
    }
  }

  let emitWarning: jest.SpyInstance

  beforeEach(() => {
    emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  })

  it('reads the values of an instrumentations group that is a class instance', () => {
    // Scenario: `Object.entries` and a spread see only own fields, so a group whose values are
    // getters on its prototype would read as empty; each known key is read by property access.
    const config = buildInstrumentationConfig(
      loose({ instrumentations: new InstrumentationGroup({ fs: true, sendLogs: false }) }),
      signals
    )
    expect(config[FS]).toEqual({ enabled: true })
    expect(config[PINO]).toEqual({ disableLogSending: true })
  })

  it('treats the absent values of that group as absent', () => {
    // Scenario: the control for the case above, with the getters returning null and undefined.
    const config = buildInstrumentationConfig(
      loose({ instrumentations: new InstrumentationGroup({ fs: null, sendLogs: undefined }) }),
      signals
    )
    expect(config).toEqual(buildInstrumentationConfig({}, signals))
  })

  it('reads an unsafe group that is a class instance', () => {
    // Scenario: a redaction turned off through a getter is still turned off, and still said so.
    warnAboutUnsafeOptions(loose({ unsafe: new UnsafeGroup({ disableUrlRedaction: true }) }))
    expect(emitWarning).toHaveBeenCalledTimes(1)
  })

  it('counts the values of an options object that is a class instance as passed', () => {
    // Scenario: a repeated start whose options are a class instance passed options, which were
    // ignored; `Object.values` would see no own field and stay silent.
    warnAboutIgnoredOptions(loose(new CallOptions({ serviceName: 'api' })))
    expect(emitWarning).toHaveBeenCalledTimes(1)
  })

  it('counts a class instance whose values are all absent as having passed none', () => {
    // Scenario: the control for the case above, with the getters returning null.
    warnAboutIgnoredOptions(
      loose(new CallOptions({ serviceName: null, instrumentations: undefined }))
    )
    expect(emitWarning).not.toHaveBeenCalled()
  })
})
