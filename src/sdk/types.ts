/**
 * @fileoverview Public option and handle types of the SDK entry point.
 * @layer sdk
 */
import type { InstrumentationConfigMap } from '@opentelemetry/auto-instrumentations-node'

/** The request an incoming-request predicate sees: only its target, as the server received it. */
export interface IncomingRequestTarget {
  /** Path and query of the request, or `undefined` when the instrumentation has no target. */
  readonly url?: string | undefined
}

/**
 * Switches that turn a redaction off. Each one is a literal `true`, so turning redaction off is
 * always an explicit, greppable act, and each one emits a process warning at boot.
 */
export interface UnsafeOptions {
  /**
   * Keeps `url.query`, `url.full`, `http.url` and `http.target` as the instrumentations set them.
   * Only the span-end redaction is switched off: the credential-parameter redaction on outgoing
   * request URLs stays on.
   */
  readonly disableUrlRedaction?: true
  /** Keeps Redis command arguments in `db.query.text`, including `EVAL` and `EVALSHA` payloads. */
  readonly disableRedisArgumentRedaction?: true
  /**
   * Keeps `process.command_args`, `process.command_line` and `process.command` in the exported
   * resource. They are removed by default, because command-line arguments are a common carrier of
   * secrets, and `process.command` is the first argument for `node -e code ARG`.
   */
  readonly exportProcessCommandArgs?: true
  /**
   * Keeps `host.id` in the exported resource. It is removed by default: it is the machine
   * identifier (the platform UUID, or `/etc/machine-id`), a stable hardware id that every collector
   * and backend would see. `host.name` stays.
   */
  readonly exportHostId?: true
}

/** Instrumentation choices that are the host's policy, with their safe defaults. */
export interface InstrumentationOptions {
  /** File-system instrumentation. Off by default: it floods traces with context-free disk activity. */
  readonly fs?: boolean
  /**
   * Whether the records of pino, winston and bunyan are forwarded to the OpenTelemetry logs
   * pipeline. Defaults to whether `OTEL_LOGS_EXPORTER` names an exporter that exports logs.
   */
  readonly sendLogs?: boolean
  /**
   * Per-instrumentation configuration merged over the library's. The redaction settings are applied
   * after the merge and cannot be replaced here: a host list of query parameters is added to the
   * library's, and the Redis serializer is the library's. Turning the Redis one off takes
   * {@link UnsafeOptions}.
   */
  readonly overrides?: InstrumentationConfigMap
}

/** Options of {@link startTelemetry}. Every field is the host's policy; none is required. */
export interface TelemetryOptions {
  /**
   * Starts the SDK unless `false`. The standard `OTEL_SDK_DISABLED=true` switch disables it
   * whatever this says, so an operator can always turn tracing off.
   */
  readonly enabled?: boolean
  /**
   * Service name. `OTEL_SERVICE_NAME` overrides it when set, and `unknown_service:node`, the
   * OpenTelemetry specification's default, applies when neither names a service.
   */
  readonly serviceName?: string
  /** Service version. */
  readonly serviceVersion?: string
  /** Returns `true` for an incoming request that must produce no server span. Defaults to none. */
  readonly ignoreIncomingRequest?: (request: IncomingRequestTarget) => boolean
  /** Instrumentation choices. */
  readonly instrumentations?: InstrumentationOptions
  /** Query-parameter names redacted from outgoing request URLs, added to the library's list. */
  readonly extraRedactedQueryParams?: readonly string[]
  /** Explicit opt-outs from redaction. */
  readonly unsafe?: UnsafeOptions
  /**
   * The longest `shutdown` waits for the final flush, in milliseconds. A collector that accepts a
   * connection and never answers cannot hold the process past it: shutdown warns with
   * `BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT` and resolves, and spans still queued may be lost. Defaults
   * to 5000; a value that is not a finite number above zero, or is above 120000, means the default.
   */
  readonly shutdownTimeoutMs?: number
  /**
   * The environment the library reads, which defaults to the process environment. The OTel SDK
   * reads `OTEL_EXPORTER_OTLP_*` and the sampler variables from the process environment itself.
   */
  readonly env?: NodeJS.ProcessEnv
}

/** What {@link startTelemetry} returns. */
export interface TelemetryHandle {
  /** Whether the SDK was started. */
  readonly enabled: boolean
  /** Flushes buffered spans and stops the SDK. Resolves immediately when it was never started. */
  shutdown(): Promise<void>
}
