/**
 * @fileoverview Pure assembly of the SDK configuration from options and environment.
 * @layer sdk
 */
import type { InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node'

import type { TelemetryEnvironment } from './environment'
import { buildRedactedQueryParams, serializeRedisCommandName } from './redaction'
import type { TelemetryOptions } from './types'

const FS_INSTRUMENTATION = '@opentelemetry/instrumentation-fs'
const HTTP_INSTRUMENTATION = '@opentelemetry/instrumentation-http'
const IOREDIS_INSTRUMENTATION = '@opentelemetry/instrumentation-ioredis'
const PINO_INSTRUMENTATION = '@opentelemetry/instrumentation-pino'

/** The exporter names under which the SDK exports logs; any other value sets up no log export. */
const LOG_EXPORTERS = new Set(['otlp', 'console'])

/** The OpenTelemetry specification's default service name, which the SDK does not apply on its own. */
const UNKNOWN_SERVICE_NAME = 'unknown_service:node'

/** The type and code every warning about a disabled redaction carries, so an operator can filter on them. */
const WARNING_OPTIONS = {
  type: 'SecurityWarning',
  code: 'BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED'
}

/** Overrides that keep a signal other than traces off. */
export interface SignalPlan {
  readonly overrides: { metricReaders?: never[]; logRecordProcessors?: never[] }
  readonly sendLogs: boolean
}

/**
 * Decides which signals besides traces are exported.
 *
 * @param env - The parsed environment.
 * @returns The SDK overrides and whether pino forwards its records.
 */
export function planSignals(env: TelemetryEnvironment): SignalPlan {
  const overrides: SignalPlan['overrides'] = {}
  if (env.metricsExporters.length === 0) overrides.metricReaders = []
  if (env.logsExporters.length === 0) overrides.logRecordProcessors = []
  return {
    overrides,
    sendLogs:
      !env.logsExporters.includes('none') &&
      env.logsExporters.some((name) => LOG_EXPORTERS.has(name))
  }
}

/**
 * Builds the resource attributes.
 *
 * @param options - The start options.
 * @param env - The parsed environment.
 * @returns The semantic-convention attributes.
 */
export function buildResourceAttributes(
  options: TelemetryOptions,
  env: TelemetryEnvironment
): Record<string, string> {
  const attributes: Record<string, string> = {}
  // The operator's standard override wins over the name the code passed; blanks count as absent.
  const name = env.serviceName ?? (options.serviceName === '' ? undefined : options.serviceName)
  attributes['service.name'] = name ?? UNKNOWN_SERVICE_NAME
  if (options.serviceVersion !== undefined && options.serviceVersion !== '') {
    attributes['service.version'] = options.serviceVersion
  }
  return attributes
}

/**
 * Builds the auto-instrumentation configuration.
 *
 * The library's settings are merged under the host's `overrides`, and the redaction settings are
 * then applied again on top, so an override that supplies its own `redactedQueryParams` or
 * `dbStatementSerializer` cannot silently undo them: a host list is added to the library's, and the
 * serializer stays the library's unless the host opted out through `unsafe`.
 *
 * @param options - The start options.
 * @param signals - The signal plan.
 * @returns The configuration map.
 */
export function buildInstrumentationConfig(
  options: TelemetryOptions,
  signals: SignalPlan
): InstrumentationConfigMap {
  const instrumentations = options.instrumentations ?? {}
  const overrides: Record<string, Record<string, unknown>> = {}
  for (const [name, config] of Object.entries(instrumentations.overrides ?? {})) {
    if (config !== undefined) overrides[name] = { ...config }
  }
  const redactRedis = options.unsafe?.disableRedisArgumentRedaction !== true
  const library: Record<string, Record<string, unknown>> = {
    [FS_INSTRUMENTATION]: { enabled: instrumentations.fs === true },
    [HTTP_INSTRUMENTATION]: {},
    [PINO_INSTRUMENTATION]: { disableLogSending: !(instrumentations.sendLogs ?? signals.sendLogs) }
  }
  const merged: Record<string, Record<string, unknown>> = {}
  for (const name of new Set([...Object.keys(library), ...Object.keys(overrides)])) {
    merged[name] = { ...library[name], ...overrides[name] }
  }
  const hostParams = merged[HTTP_INSTRUMENTATION]?.['redactedQueryParams']
  merged[HTTP_INSTRUMENTATION] = {
    ...merged[HTTP_INSTRUMENTATION],
    redactedQueryParams: buildRedactedQueryParams([
      ...(Array.isArray(hostParams) ? (hostParams as string[]) : []),
      ...(options.extraRedactedQueryParams ?? [])
    ])
  }
  if (options.ignoreIncomingRequest !== undefined) {
    merged[HTTP_INSTRUMENTATION]['ignoreIncomingRequestHook'] = options.ignoreIncomingRequest
  }
  if (redactRedis) {
    merged[IOREDIS_INSTRUMENTATION] = {
      ...merged[IOREDIS_INSTRUMENTATION],
      dbStatementSerializer: serializeRedisCommandName
    }
  }
  return merged as InstrumentationConfigMap
}

/**
 * Emits one process warning per redaction that was turned off.
 *
 * @param options - The start options.
 */
export function warnAboutUnsafeOptions(options: TelemetryOptions): void {
  if (options.unsafe?.disableUrlRedaction === true) {
    process.emitWarning(
      'URL redaction is disabled: url.query, url.full, http.url and http.target are exported as recorded.',
      WARNING_OPTIONS
    )
  }
  if (options.unsafe?.disableRedisArgumentRedaction === true) {
    process.emitWarning(
      'Redis argument redaction is disabled: command arguments, EVAL and EVALSHA payloads included, are exported in db.query.text.',
      WARNING_OPTIONS
    )
  }
}
