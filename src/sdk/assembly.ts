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
const REDIS_INSTRUMENTATION = '@opentelemetry/instrumentation-redis'
const PINO_INSTRUMENTATION = '@opentelemetry/instrumentation-pino'
const WINSTON_INSTRUMENTATION = '@opentelemetry/instrumentation-winston'
const BUNYAN_INSTRUMENTATION = '@opentelemetry/instrumentation-bunyan'

/** The exporter names under which the SDK exports logs; any other value sets up no log export. */
const LOG_EXPORTERS = new Set(['otlp', 'console'])

/** The OpenTelemetry specification's default service name, which the SDK does not apply on its own. */
const UNKNOWN_SERVICE_NAME = 'unknown_service:node'

/** The type and code every warning about a disabled redaction carries, so an operator can filter on them. */
const WARNING_OPTIONS = {
  type: 'SecurityWarning',
  code: 'BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED'
}

/** The type and code of the warning about a call that has no effect on a running SDK. */
const IGNORED_WARNING = { type: 'Warning', code: 'BYMAX_TELEMETRY_OPTIONS_IGNORED' }

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
 * Reads an optional string option, treating a blank value as absent.
 *
 * @param value - The option value.
 * @returns The trimmed value, or `undefined` when it is absent or blank.
 */
function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === '' ? undefined : trimmed
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
  const name = env.serviceName ?? nonBlank(options.serviceName)
  attributes['service.name'] = name ?? UNKNOWN_SERVICE_NAME
  const version = nonBlank(options.serviceVersion)
  if (version !== undefined) attributes['service.version'] = version
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
  const disableLogSending = !(instrumentations.sendLogs ?? signals.sendLogs)
  const library: Record<string, Record<string, unknown>> = {
    [FS_INSTRUMENTATION]: { enabled: instrumentations.fs === true },
    [HTTP_INSTRUMENTATION]: {},
    [PINO_INSTRUMENTATION]: { disableLogSending },
    [WINSTON_INSTRUMENTATION]: { disableLogSending },
    [BUNYAN_INSTRUMENTATION]: { disableLogSending }
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
    for (const name of [IOREDIS_INSTRUMENTATION, REDIS_INSTRUMENTATION]) {
      merged[name] = { ...merged[name], dbStatementSerializer: serializeRedisCommandName }
    }
  }
  return merged as InstrumentationConfigMap
}

/**
 * Emits one process warning when no service name is set and the specification default applies.
 *
 * @param options - The start options.
 * @param env - The parsed environment.
 */
export function warnAboutMissingServiceName(
  options: TelemetryOptions,
  env: TelemetryEnvironment
): void {
  if (env.serviceName === undefined && nonBlank(options.serviceName) === undefined) {
    process.emitWarning(
      'No service name is set, so spans are exported as unknown_service:node. Set OTEL_SERVICE_NAME or the serviceName option.',
      { type: 'Warning', code: 'BYMAX_TELEMETRY_SERVICE_NAME_MISSING' }
    )
  }
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
  if (options.unsafe?.exportProcessCommandArgs === true) {
    process.emitWarning(
      'Process command-line redaction is disabled: process.command_args, process.command_line and process.command are exported in the resource, and command-line arguments can carry secrets.',
      WARNING_OPTIONS
    )
  }
  if (options.unsafe?.exportHostId === true) {
    process.emitWarning(
      'Host id redaction is disabled: host.id, the machine identifier, is exported in the resource, and it identifies the machine to every collector and backend.',
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

/**
 * Emits one process warning per timer variable that was ignored for being longer than a timer holds.
 *
 * @param env - The parsed environment.
 */
export function warnAboutOversizedTimers(env: TelemetryEnvironment): void {
  for (const name of env.oversizedTimers) {
    process.emitWarning(
      `${name} is above 2147483647 ms, which a timer cannot hold, so the default applies. Set a value up to 2147483647.`,
      { type: 'Warning', code: 'BYMAX_TELEMETRY_BSP_VALUE_IGNORED' }
    )
  }
}

/**
 * Emits a warning when a call reaches an SDK that is already running and so changes nothing.
 *
 * A call with `enabled: false` is told that it does not stop the running SDK; any other call is
 * told that its options were ignored, but only when it passed at least one, so a bare repeated
 * start stays silent. Comparing the options with the first call's was rejected: a predicate built
 * by `ignorePaths` is a new function every call, so every repeat would differ.
 *
 * @param options - The options of the later call.
 */
export function warnAboutIgnoredOptions(options: TelemetryOptions): void {
  const stop = options.enabled === false
  if (stop || Object.values(options).some((v) => v !== undefined)) {
    process.emitWarning(
      stop
        ? 'startTelemetry({ enabled: false }) was called while telemetry is already running. It does not stop the running SDK: call shutdownTelemetry() for that.'
        : 'startTelemetry was called while telemetry is already running, so the options of this call were ignored. Pass them to the first call.',
      IGNORED_WARNING
    )
  }
}
