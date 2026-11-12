import {
  buildInstrumentationConfig,
  buildResourceAttributes,
  planSignals,
  warnAboutUnsafeOptions
} from './assembly'
import { readTelemetryEnvironment } from './environment'
import type { TelemetryEnvironment } from './environment'
import { DEFAULT_REDACTED_QUERY_PARAMS, serializeRedisCommandName } from './redaction'
import type { TelemetryOptions, UnsafeOptions } from './types'

const FS = '@opentelemetry/instrumentation-fs'
const HTTP = '@opentelemetry/instrumentation-http'
const IOREDIS = '@opentelemetry/instrumentation-ioredis'
const PINO = '@opentelemetry/instrumentation-pino'

/** The parsed environment for a map of raw variables. */
function environment(raw: NodeJS.ProcessEnv = {}): TelemetryEnvironment {
  return readTelemetryEnvironment(raw)
}

describe('planSignals', () => {
  it('keeps metrics and logs off when no exporter is named', () => {
    // Scenario: the OTel default for both is otlp, which would send them a second time; with
    // nothing named, the SDK is told to register neither.
    expect(planSignals(environment())).toEqual({
      overrides: { metricReaders: [], logRecordProcessors: [] },
      sendLogs: false
    })
  })

  it('leaves metrics to the SDK when OTEL_METRICS_EXPORTER names an exporter', () => {
    // Scenario: the operator asked for metrics, so no override is emitted for them.
    const plan = planSignals(environment({ OTEL_METRICS_EXPORTER: 'otlp' }))
    expect(plan.overrides).toEqual({ logRecordProcessors: [] })
  })

  it.each(['otlp', 'console'])('forwards pino logs when OTEL_LOGS_EXPORTER is %s', (name) => {
    // Scenario: only an exporter that actually exports logs makes log forwarding worth it.
    const plan = planSignals(environment({ OTEL_LOGS_EXPORTER: name }))
    expect(plan).toEqual({ overrides: { metricReaders: [] }, sendLogs: true })
  })

  it.each(['none', 'otlp,none', 'zipkin'])('does not forward pino logs for %s', (value) => {
    // Scenario: "none" anywhere, or a name that exports no logs, leaves pino's records with
    // nowhere to go.
    expect(planSignals(environment({ OTEL_LOGS_EXPORTER: value })).sendLogs).toBe(false)
  })
})

describe('buildResourceAttributes', () => {
  it('falls back to the specification default when nothing names a service', () => {
    // Scenario: the SDK applies no default name of its own, so the library applies the one the
    // OpenTelemetry specification defines.
    expect(buildResourceAttributes({}, environment())).toEqual({
      'service.name': 'unknown_service:node'
    })
  })

  it('uses the host name and version', () => {
    // Scenario: the host passes its identity.
    expect(
      buildResourceAttributes({ serviceName: 'api', serviceVersion: '1.2.3' }, environment())
    ).toEqual({ 'service.name': 'api', 'service.version': '1.2.3' })
  })

  it('lets OTEL_SERVICE_NAME override the host name', () => {
    // Scenario: the operator's standard override wins over what the code passed.
    expect(
      buildResourceAttributes({ serviceName: 'api' }, environment({ OTEL_SERVICE_NAME: 'billing' }))
    ).toEqual({ 'service.name': 'billing' })
  })

  it('treats blank names and versions as absent', () => {
    // Scenario: an empty string must not undercut a real name or produce an empty attribute.
    expect(
      buildResourceAttributes(
        { serviceName: '', serviceVersion: '' },
        environment({ OTEL_SERVICE_NAME: 'billing' })
      )
    ).toEqual({ 'service.name': 'billing' })
    expect(buildResourceAttributes({ serviceName: '' }, environment())).toEqual({
      'service.name': 'unknown_service:node'
    })
  })
})

describe('buildInstrumentationConfig', () => {
  const noLogs = planSignals(environment())
  const logs = planSignals(environment({ OTEL_LOGS_EXPORTER: 'otlp' }))

  it('applies the safe defaults', () => {
    // Scenario: a host that passes nothing gets file-system tracing off, URL and Redis redaction
    // on, and no log forwarding.
    expect(buildInstrumentationConfig({}, noLogs)).toEqual({
      [FS]: { enabled: false },
      [HTTP]: { redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS] },
      [IOREDIS]: { dbStatementSerializer: serializeRedisCommandName },
      [PINO]: { disableLogSending: true }
    })
  })

  it('turns file-system instrumentation on when the host asks', () => {
    // Scenario: fs tracing is the host's call.
    expect(buildInstrumentationConfig({ instrumentations: { fs: true } }, noLogs)[FS]).toEqual({
      enabled: true
    })
  })

  it('adds the host query parameters to the defaults', () => {
    // Scenario: a derived backend invents a secret parameter name.
    const config = buildInstrumentationConfig({ extraRedactedQueryParams: ['session'] }, noLogs)
    expect(config[HTTP]).toEqual({
      redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS, 'session']
    })
  })

  it('passes the host predicate to the HTTP instrumentation', () => {
    // Scenario: probe paths are the host's policy, handed over as a predicate.
    const predicate = (): boolean => true
    const config = buildInstrumentationConfig({ ignoreIncomingRequest: predicate }, noLogs)
    expect(config[HTTP]).toEqual({
      redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS],
      ignoreIncomingRequestHook: predicate
    })
  })

  it('forwards pino logs when the environment exports logs and the host is silent', () => {
    // Scenario: the default follows the signal plan.
    expect(buildInstrumentationConfig({}, logs)[PINO]).toEqual({ disableLogSending: false })
  })

  it('lets the host switch pino log forwarding off or on regardless of the environment', () => {
    // Scenario: the explicit option beats the environment-derived default in both directions.
    expect(
      buildInstrumentationConfig({ instrumentations: { sendLogs: false } }, logs)[PINO]
    ).toEqual({
      disableLogSending: true
    })
    expect(
      buildInstrumentationConfig({ instrumentations: { sendLogs: true } }, noLogs)[PINO]
    ).toEqual({
      disableLogSending: false
    })
  })

  it('keeps the outgoing-URL parameter redaction when the span-end redaction is opted out', () => {
    // Scenario: disableUrlRedaction switches off the span-end redaction only; the parameter list
    // for outgoing request URLs stays on, and the predicate still applies.
    const predicate = (): boolean => false
    const config = buildInstrumentationConfig(
      { unsafe: { disableUrlRedaction: true }, ignoreIncomingRequest: predicate },
      noLogs
    )
    expect(config[HTTP]).toEqual({
      redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS],
      ignoreIncomingRequestHook: predicate
    })
  })

  it('drops the Redis serializer only when the host opts out explicitly', () => {
    // Scenario: with disableRedisArgumentRedaction no ioredis entry is emitted at all.
    const config = buildInstrumentationConfig(
      { unsafe: { disableRedisArgumentRedaction: true } },
      noLogs
    )
    expect(config).not.toHaveProperty(IOREDIS)
  })

  describe('host overrides', () => {
    it('merges an override of another instrumentation through untouched', () => {
      // Scenario: the host configures an instrumentation the library has no opinion on.
      const config = buildInstrumentationConfig(
        {
          instrumentations: {
            overrides: { '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: true } }
          }
        },
        noLogs
      )
      expect(config['@opentelemetry/instrumentation-pg']).toEqual({
        enhancedDatabaseReporting: true
      })
    })

    it('merges an override of an instrumentation the library configures', () => {
      // Scenario: the host adds a setting to the HTTP instrumentation; the library's settings stay.
      const config = buildInstrumentationConfig(
        { instrumentations: { overrides: { [HTTP]: { requireParentforIncomingSpans: true } } } },
        noLogs
      )
      expect(config[HTTP]).toEqual({
        redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS],
        requireParentforIncomingSpans: true
      })
    })

    it('lets the host decide the policy settings the library only defaults', () => {
      // Scenario: fs and pino forwarding are policy, so an explicit override beats the default.
      const config = buildInstrumentationConfig(
        {
          instrumentations: {
            overrides: { [FS]: { enabled: true }, [PINO]: { disableLogSending: false } }
          }
        },
        noLogs
      )
      expect(config[FS]).toEqual({ enabled: true })
      expect(config[PINO]).toEqual({ disableLogSending: false })
    })

    it('keeps the default query parameters when an override supplies its own list', () => {
      // Scenario: supplying redactedQueryParams replaces the instrumentation's list, so the
      // library re-applies its own on top; a host can add names but not drop the defaults.
      const config = buildInstrumentationConfig(
        { instrumentations: { overrides: { [HTTP]: { redactedQueryParams: ['mine', 'token'] } } } },
        noLogs
      )
      expect(config[HTTP]).toEqual({
        redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS, 'mine']
      })
    })

    it('does not let an override replace the Redis serializer', () => {
      // Scenario: a host override cannot silently put Redis arguments back into spans.
      const config = buildInstrumentationConfig(
        {
          instrumentations: { overrides: { [IOREDIS]: { dbStatementSerializer: () => 'leaked' } } }
        },
        noLogs
      )
      expect(config[IOREDIS]).toEqual({ dbStatementSerializer: serializeRedisCommandName })
    })

    it('uses an override predicate unless the option names one', () => {
      // Scenario: the host may pass the predicate through either door; the dedicated option wins.
      const viaOverride = (): boolean => true
      const viaOption = (): boolean => false
      const overrides = { [HTTP]: { ignoreIncomingRequestHook: viaOverride } }
      expect(
        buildInstrumentationConfig({ instrumentations: { overrides } }, noLogs)[HTTP]
      ).toMatchObject({ ignoreIncomingRequestHook: viaOverride })
      expect(
        buildInstrumentationConfig(
          { instrumentations: { overrides }, ignoreIncomingRequest: viaOption },
          noLogs
        )[HTTP]
      ).toMatchObject({ ignoreIncomingRequestHook: viaOption })
    })

    it('honours the host serializer once the Redis redaction is opted out', () => {
      // Scenario: with the explicit opt-out, the override is the host's decision.
      const serializer = (): string => 'custom'
      const config = buildInstrumentationConfig(
        {
          unsafe: { disableRedisArgumentRedaction: true },
          instrumentations: { overrides: { [IOREDIS]: { dbStatementSerializer: serializer } } }
        },
        noLogs
      )
      expect(config[IOREDIS]).toEqual({ dbStatementSerializer: serializer })
    })

    it('keeps the library lists when the override holds the redaction list and the host adds more', () => {
      // Scenario: the override list and the extra option are both added to the defaults, once each.
      const config = buildInstrumentationConfig(
        {
          extraRedactedQueryParams: ['extra', 'mine'],
          instrumentations: { overrides: { [HTTP]: { redactedQueryParams: ['mine'] } } }
        },
        noLogs
      )
      expect(config[HTTP]).toEqual({
        redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS, 'mine', 'extra']
      })
    })

    it('ignores an override entry that is explicitly undefined', () => {
      // Scenario: a host spreads an optional config into the map and one entry is undefined; an
      // entry for an instrumentation the library does not configure must not appear as an empty
      // configuration.
      const config = buildInstrumentationConfig(
        {
          instrumentations: {
            overrides: { [HTTP]: undefined, '@opentelemetry/instrumentation-redis': undefined }
          }
        },
        noLogs
      )
      expect(config[HTTP]).toEqual({ redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS] })
      expect(config).not.toHaveProperty('@opentelemetry/instrumentation-redis')
    })

    it('does not let a host list that is not an array break the merge', () => {
      // Scenario: a malformed override value for the list cannot remove the library's names.
      const config = buildInstrumentationConfig(
        { instrumentations: { overrides: { [HTTP]: { redactedQueryParams: 'token' as never } } } },
        noLogs
      )
      expect(config[HTTP]).toEqual({ redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS] })
    })
  })
})

describe('warnAboutUnsafeOptions', () => {
  let emitWarning: jest.SpyInstance

  beforeEach(() => {
    emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  })

  const options = (unsafe: UnsafeOptions): TelemetryOptions => ({ unsafe })

  it('stays silent when no redaction is turned off', () => {
    // Scenario: the default configuration has nothing to warn about.
    warnAboutUnsafeOptions({})
    warnAboutUnsafeOptions(options({}))
    expect(emitWarning).not.toHaveBeenCalled()
  })

  it('warns once, with the library code, when URL redaction is off', () => {
    // Scenario: turning a redaction off is loud, and carries a code an operator can filter on.
    warnAboutUnsafeOptions(options({ disableUrlRedaction: true }))
    expect(emitWarning).toHaveBeenCalledTimes(1)
    expect(emitWarning).toHaveBeenCalledWith(
      'URL redaction is disabled: url.query, url.full, http.url and http.target are exported as recorded.',
      { type: 'SecurityWarning', code: 'BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED' }
    )
  })

  it('warns once, with the library code, when Redis argument redaction is off', () => {
    // Scenario: the second flag has its own message.
    warnAboutUnsafeOptions(options({ disableRedisArgumentRedaction: true }))
    expect(emitWarning).toHaveBeenCalledTimes(1)
    expect(emitWarning).toHaveBeenCalledWith(
      'Redis argument redaction is disabled: command arguments, EVAL and EVALSHA payloads included, are exported in db.query.text.',
      { type: 'SecurityWarning', code: 'BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED' }
    )
  })

  it('warns for each flag when both are set', () => {
    // Scenario: two opt-outs, two warnings.
    warnAboutUnsafeOptions(
      options({ disableUrlRedaction: true, disableRedisArgumentRedaction: true })
    )
    expect(emitWarning).toHaveBeenCalledTimes(2)
  })
})
