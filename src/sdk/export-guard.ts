/**
 * @fileoverview Makes every OTLP export refuse to send while the `Object.prototype` of the process is
 * polluted, so a name planted after the start cannot redirect, decorate or crash the export.
 * @layer sdk
 *
 * The exporters read their endpoint, headers, proxy and credentials when they send, and a gRPC one reads
 * them at its first send, after anything this library did at the start, and an attempt waits for the modules it
 * loads and, after a failure, for a back-off before it retries. The check therefore runs on each export, before
 * each attempt of the transport and again just before the attempt reads its headers or credentials. It wraps the `export` of the base class that the exporters of this library's peers share, once,
 * so it reaches the metrics and logs exporters that the SDK builds itself; that wrap is process-wide.
 */
import {
  apply,
  defineProperty,
  ErrorClass,
  getOwnPropertyDescriptor,
  getPrototypeOf,
  hasOwn,
  isPromise,
  promiseThen
} from './primordials'
import { pollutedNames } from './prototype-guard'

/** The value of `ExportResultCode.FAILED` in `@opentelemetry/core`. */
const FAILED = 1

/** Marks a base class that is already wrapped, whichever copy of this library wrapped it. */
const MARK = Symbol.for('@bymax-one/nest-telemetry/export-guard')

/** Marks a transport whose attempts are already guarded. */
const ARMED = Symbol.for('@bymax-one/nest-telemetry/export-guard/transport')

/** Why a batch is dropped, shared by the check at the export and the one before each request. */
const DROPPED = 'The Object.prototype of this process is polluted, so the batch was dropped.'

/** The providers of a transport that a request reads, after the transport loaded what it needs and before it sends. */
const PROVIDERS = ['headers', 'metadata', 'credentials'] as const

/** What the guard needs of a transport: the method that makes one attempt, and the settings it reads. */
interface Transport {
  send(data: unknown, timeoutMillis: unknown): unknown
  _parameters?: Record<string, unknown>
}

/** The part of an exporter base class this module wraps. */
interface Base {
  export(items: unknown, done: (result: { code: number; error?: unknown }) => void): void
}

/**
 * Whether a base class carries the mark, as its own data property.
 *
 * @param base - The base class.
 * @returns `true` when it is already wrapped.
 */
function isMarked(base: object): boolean {
  const mark = getOwnPropertyDescriptor(base, MARK)
  return mark !== undefined && hasOwn(mark, 'value') && mark.value === true
}

/**
 * The property of an object, as its own property only.
 *
 * @param holder - An object, or anything.
 * @param name - The property.
 * @returns The own value, or `undefined`.
 */
function own(holder: unknown, name: string): unknown {
  return typeof holder === 'object' && holder !== null && hasOwn(holder, name)
    ? (holder as Record<string, unknown>)[name]
    : undefined
}

/**
 * The transport that makes the requests of an exporter: what `_delegate` holds, followed through `_transport`
 * while there is one, so a retrying transport is passed over for the one that sends.
 *
 * @param exporter - An OTLP exporter.
 * @returns The innermost transport, or `undefined` when the exporter is not shaped as expected.
 */
function innermostTransport(exporter: unknown): Transport | undefined {
  let at = own(exporter, '_delegate')
  for (let depth = 0; depth < 8; depth += 1) {
    const next = own(at, '_transport')
    if (next === undefined) break
    at = next
  }
  return typeof at === 'object' && at !== null && typeof (at as Transport).send === 'function'
    ? (at as Transport)
    : undefined
}

/** Takes the outcome of a promise that the guard dropped, so neither a rejection nor a value is passed on. */
function ignore(): void {}

/**
 * Checks again once a provider has answered: a provider the host supplied can wait, and a name planted while it
 * did would be read by the request that follows. The check comes before anything is read from the answer, and an
 * answer that is not a promise is handed back as it is, so a synchronous provider stays synchronous.
 *
 * @param answer - What the provider returned.
 * @returns The answer, or a promise of it that rejects when the prototype is polluted by then.
 */
function refuseIfPolluted(answer: unknown): unknown {
  // Before anything is read from the answer: reading its `then` could run a getter that a polluted root prototype holds.
  if (pollutedNames() > 0) {
    // A promise that is dropped must not end the host as an unhandled rejection, whether it rejects or fulfils (a
    // value passed on would be read for a then), and nothing may be read from it to find out: the slot says whether
    // it is one.
    if (isPromise(answer)) apply(promiseThen, answer, [ignore, ignore])
    throw new ErrorClass(DROPPED)
  }
  if (
    typeof answer === 'object' &&
    answer !== null &&
    typeof (answer as PromiseLike<unknown>).then === 'function'
  ) {
    return (async (): Promise<unknown> => {
      const value = await answer
      if (pollutedNames() > 0) throw new ErrorClass(DROPPED)
      return value
    })()
  }
  return answer
}

/**
 * Guards every attempt of a transport: before the attempt starts, and again after the transport loaded what it
 * needs and before it reads its headers, metadata or credentials, and once more after they were read, so a name planted while an attempt waits, for
 * the first load or for a retry, is seen. An attempt that is refused sends nothing and is not retried.
 *
 * @param exporter - An OTLP exporter whose export is being made.
 */
function armTransport(exporter: unknown): void {
  const transport = innermostTransport(exporter)
  if (transport === undefined || hasOwn(transport, ARMED)) return
  const send = transport.send
  defineProperty(transport, 'send', {
    configurable: true,
    writable: true,
    value: async function (this: unknown, data: unknown, timeoutMillis: unknown): Promise<unknown> {
      if (pollutedNames() > 0) return { status: 'failure', error: new ErrorClass(DROPPED) }
      return apply(send, this, [data, timeoutMillis])
    }
  })
  const parameters = own(transport, '_parameters') as Record<string, unknown> | undefined
  for (let at = 0; at < PROVIDERS.length; at += 1) {
    const name = PROVIDERS[at] as (typeof PROVIDERS)[number]
    const provider = own(parameters, name)
    if (typeof provider !== 'function') continue
    defineProperty(parameters, name, {
      configurable: true,
      writable: true,
      enumerable: true,
      value: function (this: unknown, ...args: unknown[]): unknown {
        if (pollutedNames() > 0) throw new ErrorClass(DROPPED)
        return refuseIfPolluted(apply(provider, this, args))
      }
    })
  }
  defineProperty(transport, ARMED, { value: true })
}

/**
 * Wraps, once, the `export` of the class that `exporter`'s own class extends. A batch that arrives while the
 * prototype is polluted is dropped with a failed result and no I/O; the error carries no name or value.
 *
 * @param exporter - An OTLP exporter that was just built.
 */
export function guardExports(exporter: object): void {
  const own = getPrototypeOf(exporter) as object | null
  const base = own === null ? null : (getPrototypeOf(own) as Base | null)
  if (base === null || typeof base.export !== 'function' || isMarked(base)) {
    return
  }
  const original = base.export
  defineProperty(base, 'export', {
    configurable: true,
    writable: true,
    value: function (
      this: unknown,
      items: unknown,
      done: (result: { code: number; error?: unknown }) => void
    ): void {
      if (pollutedNames() > 0) {
        done({ code: FAILED, error: new ErrorClass(DROPPED) })
        return
      }
      armTransport(this)
      apply(original, this, [items, done])
    }
  })
  defineProperty(base, MARK, { value: true })
}
