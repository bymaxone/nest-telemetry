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
import { POLLUTED_CODE } from './error-code'
import { absorbHost, absorbOwned, ignore, ownConstructor } from './native-promise'
import {
  apply,
  defineProperty,
  ErrorClass,
  getOwnPropertyDescriptor,
  create,
  getPrototypeOf,
  hasOwn,
  isPromise,
  NativePromise
} from './primordials'
import { pollutedNames } from './prototype-guard'

/** The value of `ExportResultCode.FAILED` in `@opentelemetry/core`. */
const FAILED = 1

/** Marks a base class that is already wrapped, whichever copy of this library wrapped it. */
const MARK = Symbol.for('@bymax-one/nest-telemetry/export-guard')

/** Marks a transport whose attempts are already guarded. */
const ARMED = Symbol.for('@bymax-one/nest-telemetry/export-guard/transport')

/** Why a batch is dropped, shared by the check at the export and the one before each request. */
const DROPPED =
  'Object.prototype or a built-in of this process was changed, so the batch was dropped.'

/**
 * The error a dropped batch fails with: its own `code` names the cause, so the warning that reports the
 * failed export names the change instead of blaming the collector. The descriptor has no
 * prototype, so a name planted on the root prototype cannot make the definition throw.
 *
 * @returns An error with the message {@link DROPPED} and an own, read-only `code`.
 */
function dropped(): Error {
  const error = new ErrorClass(DROPPED)
  defineProperty(error, 'code', { __proto__: null, value: POLLUTED_CODE } as PropertyDescriptor)
  return error
}

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

/**
 * Checks again once a provider has answered: a provider the host supplied can wait, and a name planted while it
 * did would be read by the request that follows. An answer that is not a promise is handed back as it is, so a
 * synchronous provider stays synchronous.
 *
 * A promise of the host's is waited for through the `then` captured at load and never written to, and the answer is
 * settled by a promise of this module's own with its own `constructor`: a `then` that something installed is not
 * read. A wait that cannot be made refuses the answer. The
 * check is the last thing before the value is resolved, with nothing between them, because resolving reads a `then`
 * on the value, and a `then` planted on a root prototype that erases itself when read would otherwise be read
 * after the check passed.
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
    if (isPromise(answer)) absorbHost(answer, ignore, ignore)
    throw dropped()
  }
  const native = isPromise(answer)
  if (
    !native &&
    !(
      typeof answer === 'object' &&
      answer !== null &&
      typeof (answer as PromiseLike<unknown>).then === 'function'
    )
  ) {
    return answer
  }
  return ownConstructor(
    new NativePromise<unknown>((resolve, reject) => {
      const onValue = (value: unknown): void => {
        if (pollutedNames() > 0) reject(dropped())
        else resolve(value)
      }
      if (native) {
        // The host's promise is never written to: a failed attach refuses the answer.
        if (!absorbHost(answer as Promise<unknown>, onValue, reject)) reject(dropped())
        return
      }
      // A thenable that is not a promise is adopted by a promise of ours, so the one that is consumed is a native one.
      absorbOwned(new NativePromise<unknown>((adopt) => adopt(answer)), onValue, reject)
    })
  )
}

/**
 * The result of a send that the guard refused: an object with no prototype, so that resolving a promise with it
 * reads no `then` from the root prototype.
 *
 * @returns The failed result.
 */
function refusedResult(): unknown {
  const result = create(null) as Record<string, unknown>
  result['status'] = 'failure'
  result['error'] = dropped()
  return result
}

/**
 * The `send` of a guarded transport: refuses while the process is polluted, and checks again right before it resolves.
 *
 * @param send - The transport's own `send`.
 * @returns The guarded one.
 */
function guardedSend(
  send: Transport['send']
): (this: unknown, data: unknown, timeoutMillis: unknown) => Promise<unknown> {
  return function (this: unknown, data: unknown, timeoutMillis: unknown): Promise<unknown> {
    // No `async`: returning from one resolves a promise with the value, which reads a `then` on it. The check comes
    // last before the refused result is resolved, and the result has no prototype to read one from.
    return ownConstructor(
      new NativePromise<unknown>((resolve, reject) => {
        if (pollutedNames() > 0) {
          resolve(refusedResult())
          return
        }
        try {
          const sent = apply(send, this, [data, timeoutMillis])
          // A dependency's promise is waited for natively after it took an own constructor, so a `then` that
          // something replaced cannot settle this result.
          // Checked again right before the value is resolved, which reads a `then` on it.
          const settle = (value: unknown): void =>
            resolve(pollutedNames() > 0 ? refusedResult() : value)
          if (!isPromise(sent)) settle(sent)
          else absorbOwned(sent, settle, reject)
        } catch (error) {
          reject(error)
        }
      })
    )
  }
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
    __proto__: null,
    configurable: true,
    writable: true,
    value: guardedSend(send)
  } as PropertyDescriptor)
  const parameters = own(transport, '_parameters') as Record<string, unknown> | undefined
  for (let at = 0; at < PROVIDERS.length; at += 1) {
    const name = PROVIDERS[at] as (typeof PROVIDERS)[number]
    const provider = own(parameters, name)
    if (typeof provider !== 'function') continue
    defineProperty(parameters, name, {
      __proto__: null,
      configurable: true,
      writable: true,
      enumerable: true,
      value: function (this: unknown, ...args: unknown[]): unknown {
        if (pollutedNames() > 0) throw dropped()
        return refuseIfPolluted(apply(provider, this, args))
      }
    } as PropertyDescriptor)
  }
  defineProperty(transport, ARMED, { __proto__: null, value: true } as PropertyDescriptor)
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
    __proto__: null,
    configurable: true,
    writable: true,
    value: function (
      this: unknown,
      items: unknown,
      done: (result: { code: number; error?: unknown }) => void
    ): void {
      if (pollutedNames() > 0) {
        done({ code: FAILED, error: dropped() })
        return
      }
      armTransport(this)
      apply(original, this, [items, done])
    }
  } as PropertyDescriptor)
  defineProperty(base, MARK, { __proto__: null, value: true } as PropertyDescriptor)
}
