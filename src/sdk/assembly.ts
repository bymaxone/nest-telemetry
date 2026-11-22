/**
 * @fileoverview Pure assembly of the SDK configuration from options and environment.
 * @layer sdk
 */
import type { InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node'

import type { RatioSampler, TelemetryEnvironment } from './environment'
import { readOwnOrClass, requireBoolean, requireObject, settleOverrides } from './option-kinds'
import { buildRedactedQueryParams, serializeRedisCommandName } from './redaction'
import type { InstrumentationOptions, TelemetryOptions, UnsafeOptions } from './types'
import { reportWarning } from './warning-sink'

const FS_INSTRUMENTATION = '@opentelemetry/instrumentation-fs'
const HTTP_INSTRUMENTATION = '@opentelemetry/instrumentation-http'
const IOREDIS_INSTRUMENTATION = '@opentelemetry/instrumentation-ioredis'
const REDIS_INSTRUMENTATION = '@opentelemetry/instrumentation-redis'

/**
 * The settings an instrumentation reads while it is built, before its configuration can be cut from the
 * root prototype: what each decides is which headers or metadata become attributes, which handler is
 * wrapped, and the Redis serializer and hooks that its two clients read from a copy of the
 * configuration. Each is an own key that is undefined, so a value the root prototype holds is never found.
 */
const READ_WHEN_BUILT = Object.assign(Object.create(null), {
  [HTTP_INSTRUMENTATION]: ['headersToSpanAttributes'],
  '@opentelemetry/instrumentation-grpc': ['metadataToSpanAttributes'],
  '@opentelemetry/instrumentation-aws-lambda': ['lambdaHandler'],
  [REDIS_INSTRUMENTATION]: ['dbStatementSerializer', 'responseHook', 'requireParentSpan']
}) as Readonly<Record<string, readonly string[]>>
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
 * Whether an option was given: a key that holds `undefined` or `null` is the same as no key.
 *
 * @param value - The option value.
 * @returns `false` for `undefined` and `null`.
 */
function isPresent<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null
}

/**
 * Reads each known option, so an options object that is a class instance, with its values behind
 * prototype getters, is read the same as a plain one, while a value that only the root prototype of the
 * realm holds is not the host's and is not read. The type has a key for every
 * option, so an option added to `TelemetryOptions` without a line here does not compile.
 *
 * @param options - The options of a call.
 * @returns Each option's value, or `undefined` for one that is absent.
 */
export function readEachOption(options: TelemetryOptions): Record<keyof TelemetryOptions, unknown> {
  const read = (name: keyof TelemetryOptions): unknown => readOwnOrClass(options, name)
  return {
    enabled: read('enabled'),
    serviceName: read('serviceName'),
    serviceVersion: read('serviceVersion'),
    ignoreIncomingRequest: read('ignoreIncomingRequest'),
    instrumentations: read('instrumentations'),
    extraRedactedQueryParams: read('extraRedactedQueryParams'),
    unsafe: read('unsafe'),
    shutdownTimeoutMs: read('shutdownTimeoutMs'),
    env: read('env')
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

/** The identity of the service, as the host passed it. */
export interface ServiceIdentity {
  readonly serviceName?: string | undefined
  readonly serviceVersion?: string | undefined
}

/**
 * Reads the service name and version once, each field once, into a plain object, so the warning about
 * a missing name and the resource work from the same read.
 *
 * @param options - The start options.
 * @returns The name and version as they were read.
 */
export function settleService(options: ServiceIdentity): ServiceIdentity {
  return { serviceName: options.serviceName, serviceVersion: options.serviceVersion }
}

/**
 * Builds the resource attributes.
 *
 * @param options - The start options.
 * @param env - The parsed environment.
 * @returns The semantic-convention attributes.
 */
export function buildResourceAttributes(
  options: ServiceIdentity,
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

/** The unsafe options as plain flags: each is `true` only for an explicit `true`. */
export type UnsafeFlags = { readonly [K in keyof UnsafeOptions]?: boolean | undefined }

/** The instrumentation options as a plain object, each key read once. */
export type SettledInstrumentations = {
  readonly [K in keyof InstrumentationOptions]?: InstrumentationOptions[K] | undefined
}

/** The start options the instrumentation config reads; a key may hold `undefined` for an option that was not set. */
export type InstrumentationInputs = {
  readonly instrumentations?: SettledInstrumentations | undefined
  readonly unsafe?: UnsafeFlags | undefined
  readonly extraRedactedQueryParams?: TelemetryOptions['extraRedactedQueryParams'] | undefined
  readonly ignoreIncomingRequest?: TelemetryOptions['ignoreIncomingRequest'] | undefined
}

/**
 * Reads the unsafe options once, each field once, into a plain object. Every step of a start then
 * works from this copy, so a getter, on the object or on a field, cannot answer differently to the
 * warning about a turned-off redaction and to the SDK that applies it.
 *
 * @param unsafe - The host's `unsafe` option.
 * @returns A flag per unsafe option, `true` only for an explicit `true`. The type requires every key of
 *   `UnsafeOptions`, so an option added there without a line here does not compile.
 * @throws {TelemetryOptionError} When `unsafe` is not an object or a flag is not a boolean.
 */
export function settleUnsafe(unsafe: unknown): {
  readonly [K in keyof UnsafeOptions]-?: boolean
} {
  const flags = requireObject('unsafe', unsafe)
  const flag = (name: keyof UnsafeOptions): boolean =>
    requireBoolean(`unsafe.${name}`, readOwnOrClass(flags, name)) === true
  return {
    disableUrlRedaction: flag('disableUrlRedaction'),
    disableRedisArgumentRedaction: flag('disableRedisArgumentRedaction'),
    exportProcessCommandArgs: flag('exportProcessCommandArgs'),
    exportHostId: flag('exportHostId')
  }
}

/**
 * Reads the instrumentation options once, each field once, into a plain object, for the same reason
 * as {@link settleUnsafe}.
 *
 * @param instrumentations - The host's `instrumentations` option, or one already read.
 * @returns The options as they were read. The type requires every key of `InstrumentationOptions`.
 * @throws {TelemetryOptionError} When the option, a flag or an override is of the wrong kind.
 */
export function settleInstrumentations(instrumentations: unknown): {
  readonly [K in keyof InstrumentationOptions]-?: InstrumentationOptions[K] | undefined
} {
  const read = requireObject('instrumentations', instrumentations)
  return {
    fs: requireBoolean('instrumentations.fs', readOwnOrClass(read, 'fs')),
    sendLogs: requireBoolean('instrumentations.sendLogs', readOwnOrClass(read, 'sendLogs')),
    overrides: settleOverrides('instrumentations.overrides', readOwnOrClass(read, 'overrides')) as
      InstrumentationConfigMap | undefined
  }
}

/** The start of the name of every instrumentation `getNodeAutoInstrumentations` configures. */
const INSTRUMENTATION_PREFIX = '@opentelemetry/instrumentation-'

/**
 * Wraps the instrumentation configuration so that every instrumentation name answers with an entry that
 * has no prototype. `getNodeAutoInstrumentations` hands an instrumentation that has no entry an empty
 * object of its own, which would inherit a planted `enabled`. The keys of the map stay the ones that were
 * set, and nothing that is not an instrumentation name (a symbol, `then`, `toJSON`) gets an answer.
 *
 * @param map - The configuration, by instrumentation name.
 * @returns The same map, answering with an empty entry for an instrumentation name it does not hold.
 */
function answerEveryName(map: Record<string, Record<string, unknown>>): InstrumentationConfigMap {
  return new Proxy(map, {
    get: (target, name): Record<string, unknown> | undefined =>
      typeof name === 'string' && name.startsWith(INSTRUMENTATION_PREFIX)
        ? (target[name] ?? Object.create(null))
        : undefined
  }) as InstrumentationConfigMap
}

/**
 * Merges, by instrumentation name, what each instrumentation reads while it is built, the library's
 * settings and the host's overrides, into entries with no prototype.
 *
 * @param library - The library's settings by name.
 * @param overrides - The host's overrides by name.
 * @returns The entries, by name.
 */
function mergeEntries(
  library: Record<string, Record<string, unknown>>,
  overrides: Record<string, Record<string, unknown>>
): Record<string, Record<string, unknown>> {
  const merged = Object.create(null) as Record<string, Record<string, unknown>>
  const names = [
    ...Object.keys(library),
    ...Object.keys(overrides),
    ...Object.keys(READ_WHEN_BUILT)
  ]
  for (const name of new Set(names)) {
    const shadows = Object.fromEntries((READ_WHEN_BUILT[name] ?? []).map((key) => [key, undefined]))
    merged[name] = Object.assign(Object.create(null), shadows, library[name], overrides[name])
  }
  return merged
}

/**
 * Builds the auto-instrumentation configuration.
 *
 * The library's settings are merged under the host's `overrides`, and the redaction settings are
 * then applied again on top, so an override that supplies its own `redactedQueryParams` or
 * `dbStatementSerializer` cannot silently undo them: a host list is added to the library's, and the
 * serializer stays the library's unless the host opted out through `unsafe`.
 *
 * @param options - The start options this reads, each read once by the caller.
 * @param signals - The signal plan.
 * @returns The configuration map.
 */
export function buildInstrumentationConfig(
  options: InstrumentationInputs,
  signals: SignalPlan
): InstrumentationConfigMap {
  const instrumentations = settleInstrumentations(options.instrumentations)
  // Records with no prototype: a name that a polluted root prototype holds is not an instrumentation of
  // the host, and the lookups below must not find it.
  const overrides = Object.create(null) as Record<string, Record<string, unknown>>
  for (const [name, config] of Object.entries(instrumentations.overrides ?? {})) {
    // `settleInstrumentations` copied the entry and dropped the settings that are absent.
    overrides[name] = config as Record<string, unknown>
  }
  const redactRedis = options.unsafe?.disableRedisArgumentRedaction !== true
  const disableLogSending = !(instrumentations.sendLogs ?? signals.sendLogs)
  const library = Object.assign(Object.create(null), {
    [FS_INSTRUMENTATION]: { enabled: instrumentations.fs === true },
    [HTTP_INSTRUMENTATION]: {},
    [PINO_INSTRUMENTATION]: { disableLogSending },
    [WINSTON_INSTRUMENTATION]: { disableLogSending },
    [BUNYAN_INSTRUMENTATION]: { disableLogSending }
  }) as Record<string, Record<string, unknown>>
  const merged = mergeEntries(library, overrides)
  const hostParams = merged[HTTP_INSTRUMENTATION]?.['redactedQueryParams']
  merged[HTTP_INSTRUMENTATION] = Object.assign(Object.create(null), merged[HTTP_INSTRUMENTATION], {
    redactedQueryParams: buildRedactedQueryParams([
      ...(Array.isArray(hostParams) ? (hostParams as string[]) : []),
      ...(options.extraRedactedQueryParams ?? [])
    ])
  }) as Record<string, unknown>
  const ignoreIncomingRequest = options.ignoreIncomingRequest
  if (isPresent(ignoreIncomingRequest)) {
    merged[HTTP_INSTRUMENTATION]['ignoreIncomingRequestHook'] = ignoreIncomingRequest
  }
  if (redactRedis) {
    for (const name of [IOREDIS_INSTRUMENTATION, REDIS_INSTRUMENTATION]) {
      merged[name] = Object.assign(Object.create(null), merged[name], {
        dbStatementSerializer: serializeRedisCommandName
      }) as Record<string, unknown>
    }
  }
  return answerEveryName(merged)
}

/**
 * Cuts the settings an instrumentation reads while it works from the root prototype of the realm, so a
 * hook or an attribute list that a polluted realm planted there is not found when a request arrives.
 *
 * @param instrumentation - A constructed instrumentation.
 * @returns The same instrumentation.
 */
export function severFromRootPrototype<T extends { getConfig(): object }>(instrumentation: T): T {
  Object.setPrototypeOf(instrumentation.getConfig(), null)
  return instrumentation
}

/**
 * Emits one process warning when no service name is set and the specification default applies.
 *
 * @param options - The start options.
 * @param env - The parsed environment.
 */
export function warnAboutMissingServiceName(
  options: Pick<ServiceIdentity, 'serviceName'>,
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
export function warnAboutUnsafeOptions(options: {
  readonly unsafe?: UnsafeFlags | undefined
}): void {
  const unsafe = options.unsafe
  if (unsafe?.disableUrlRedaction === true) {
    process.emitWarning(
      'URL redaction is disabled: url.query, url.full, http.url and http.target are exported as recorded.',
      WARNING_OPTIONS
    )
  }
  if (unsafe?.exportProcessCommandArgs === true) {
    process.emitWarning(
      'Process command-line redaction is disabled: process.command_args, process.command_line and process.command are exported in the resource, and command-line arguments can carry secrets.',
      WARNING_OPTIONS
    )
  }
  if (unsafe?.exportHostId === true) {
    process.emitWarning(
      'Host id redaction is disabled: host.id, the machine identifier, is exported in the resource, and it identifies the machine to every collector and backend.',
      WARNING_OPTIONS
    )
  }
  if (unsafe?.disableRedisArgumentRedaction === true) {
    process.emitWarning(
      'Redis argument redaction is disabled: command arguments, EVAL and EVALSHA payloads included, are exported in db.query.text.',
      WARNING_OPTIONS
    )
  }
}

/** The longest part of an operator's ratio value that a warning repeats. */
const SHOWN_VALUE_LENGTH = 40

/**
 * Characters `JSON.stringify` leaves as they are but that break, reorder or hide text in a log line:
 * the delete and C1 controls (`Cc`), every format character (`Cf`: the soft hyphen, the zero-width
 * characters, the direction marks, overrides and isolates, the invisible operators and the byte order
 * mark) and the line and paragraph separators (`Zl`, `Zp`). Named by category, so a character the
 * Unicode standard adds to one of them is covered without a list to keep.
 */
const UNSAFE_IN_LOG = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * Quotes a value the operator wrote so it can be repeated in a warning: cut short, and with every
 * control, separator and format character written as `\uXXXX`, or `\u{X}` beyond the first plane.
 *
 * @param value - The operator's text.
 * @returns The quoted, escaped, shortened text.
 */
function quoteOperatorValue(value: string): string {
  return JSON.stringify(value.slice(0, SHOWN_VALUE_LENGTH)).replace(UNSAFE_IN_LOG, (char) => {
    const hex = Number(char.codePointAt(0)).toString(16)
    return hex.length > 4 ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`
  })
}

/**
 * Reports a ratio sampler whose ratio the SDK will not use.
 *
 * Given a ratio sampler, the SDK reads the ratio with `Number` and falls back to 1 when the argument
 * is unset, blank, not a number or outside 0 to 1, noting it only on the diagnostic channel. Every
 * trace is then sampled, which is what a ratio was set to avoid. The value is operator configuration,
 * so it is repeated, cut short and quoted so that control characters are escaped.
 *
 * @param sampler - The ratio sampler the environment selects, if any.
 */
export function warnAboutSamplerRatio(sampler: RatioSampler | undefined): void {
  if (sampler === undefined) return
  // `Number` reads a blank string as 0, which is a usable ratio; the SDK reads it as no argument.
  const ratio = sampler.arg?.trim() === '' ? Number.NaN : Number(sampler.arg)
  if (ratio >= 0 && ratio <= 1) return
  const given =
    sampler.arg === undefined
      ? 'not set'
      : sampler.arg.trim() === ''
        ? 'blank'
        : `${quoteOperatorValue(sampler.arg)}, which is not a number from 0 to 1`
  reportWarning({
    code: 'BYMAX_TELEMETRY_SAMPLER_ARG_INVALID',
    text: `OTEL_TRACES_SAMPLER is ${sampler.name}, but OTEL_TRACES_SAMPLER_ARG is ${given}, so the SDK samples every trace. Set it to the share of traces to keep, from 0 to 1, such as 0.1.`
  })
}

/**
 * Reports a sampler name that differs from a known one only by letter case or surrounding whitespace.
 *
 * The SDK compares the name exactly and, for any other value, uses its default sampler, which keeps
 * every trace. The value is not repeated: only the name that was meant is.
 *
 * @param meant - The known sampler name the value was close to, if any.
 */
export function warnAboutSamplerName(meant: string | undefined): void {
  if (meant === undefined) return
  reportWarning({
    code: 'BYMAX_TELEMETRY_SAMPLER_NAME_UNKNOWN',
    text: `OTEL_TRACES_SAMPLER differs from "${meant}" only in letter case or whitespace. The SDK compares the name exactly, so it ignores the value and samples every trace. Write it as "${meant}".`
  })
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
  if (stop || Object.values(readEachOption(options)).some(isPresent)) {
    process.emitWarning(
      stop
        ? 'startTelemetry({ enabled: false }) was called while telemetry is already running. It does not stop the running SDK: call shutdownTelemetry() for that.'
        : 'startTelemetry was called while telemetry is already running, so the options of this call were ignored. Pass them to the first call.',
      IGNORED_WARNING
    )
  }
}
