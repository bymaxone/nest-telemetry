/**
 * @fileoverview Redaction of span data: the span-end processor logic, the query-parameter list
 * for outgoing requests, and the Redis command serializer.
 * @layer sdk
 *
 * Nothing here imports an OpenTelemetry package at runtime; the type imports are erased. A boot
 * with telemetry disabled loads this module, so it must not pull the SDK graph in.
 */
import type { AttributeValue, Attributes } from '@opentelemetry/api'
import type { SpanProcessor } from '@opentelemetry/sdk-trace'

/** Marker a redacted query string is replaced with: it shows a query was present, not what it held. */
export const REDACTED_QUERY_VALUE = '[redacted]'

/** The attribute carrying the raw query string of a server span. */
const URL_QUERY_ATTRIBUTE = 'url.query'

/**
 * Attributes that carry a whole request target, query included. The stable conventions record
 * `url.full`; the legacy `http.url` and `http.target` appear when a host opts into them.
 */
const TARGET_ATTRIBUTES = ['url.full', 'http.url', 'http.target'] as const

/**
 * Query-parameter names redacted from the URL of outgoing requests. Supplying a list to the HTTP
 * instrumentation REPLACES the names it redacts by default, so those are repeated here, first, ahead
 * of the credential-bearing names added on top. A test compares the first seven with the installed
 * instrumentation's own list, so a name it adds later is caught.
 */
export const DEFAULT_REDACTED_QUERY_PARAMS: readonly string[] = [
  'sig',
  'Signature',
  'AWSAccessKeyId',
  'X-Goog-Signature',
  'X-Amz-Signature',
  'X-Amz-Credential',
  'X-Amz-Security-Token',
  'token',
  'code',
  'access_token',
  'refresh_token',
  'id_token',
  'secret',
  'password',
  'api_key',
  'apikey',
  'key',
  'signature',
  'sas',
  'auth'
]

/**
 * The mutable-span surface the redaction needs: the recorded attributes to read and the SDK's
 * supported `setAttribute` writer. A span processor's `onEnding` hook receives a span of this
 * shape, which is why redaction runs there and not in `onEnd`, whose `ReadableSpan` the SDK does
 * not intend to be written.
 */
export interface MutableSpanAttributes {
  /** Attributes recorded so far. */
  readonly attributes: Attributes
  /** Writes one attribute. */
  setAttribute(key: string, value: AttributeValue): unknown
}

/**
 * Builds the list of query-parameter names redacted from outgoing request URLs.
 *
 * @param extra - Names the host adds to the defaults.
 * @returns The defaults followed by the names in `extra` they do not already contain.
 */
export function buildRedactedQueryParams(extra: readonly string[]): string[] {
  return [...new Set([...DEFAULT_REDACTED_QUERY_PARAMS, ...extra])]
}

/**
 * Strips the request query out of a span's URL attributes.
 *
 * `url.query` is replaced wholesale by {@link REDACTED_QUERY_VALUE}, and the query is cut from every
 * attribute that carries a whole target, keeping the path. The whole query goes rather than named
 * parameters, because the library cannot enumerate every secret parameter name a host will invent.
 *
 * @param span - The mutable span, read for its URL attributes and written through `setAttribute`.
 */
export function redactSpanUrlQuery(span: MutableSpanAttributes): void {
  if (URL_QUERY_ATTRIBUTE in span.attributes) {
    span.setAttribute(URL_QUERY_ATTRIBUTE, REDACTED_QUERY_VALUE)
  }
  for (const key of TARGET_ATTRIBUTES) {
    const target = span.attributes[key]
    if (typeof target === 'string' && target.includes('?')) {
      span.setAttribute(key, target.slice(0, target.indexOf('?')))
    }
  }
}

/**
 * Creates the span processor that redacts every span as it ends, whichever instrumentation made it.
 *
 * @returns A span processor whose only effect is {@link redactSpanUrlQuery}.
 */
export function createUrlQueryRedactor(): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnding: (span): void => {
      redactSpanUrlQuery(span)
    },
    onEnd: () => undefined,
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve()
  }
}

/**
 * Serializes a Redis command to its name alone.
 *
 * The default serializer keeps the arguments of many commands, and `EVAL` and `EVALSHA` carry their
 * `KEYS` and `ARGV` payloads there, so the default would export whatever a host stores in Redis.
 *
 * @param commandName - The Redis command name.
 * @returns The command name with every argument dropped.
 */
export function serializeRedisCommandName(commandName: string): string {
  return commandName
}
