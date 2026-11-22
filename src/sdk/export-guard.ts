/**
 * @fileoverview Makes every OTLP export refuse to send while the `Object.prototype` of the process is
 * polluted, so a name planted after the start cannot redirect, decorate or crash the export.
 * @layer sdk
 *
 * The exporters read their endpoint, headers, proxy and credentials when they send, and a gRPC one reads
 * them at its first send, after anything this library did at the start. The check therefore runs on each
 * export. It wraps the `export` of the base class that the exporters of this library's peers share, once,
 * so it reaches the metrics and logs exporters that the SDK builds itself; that wrap is process-wide.
 */
import {
  apply,
  defineProperty,
  ErrorClass,
  getOwnPropertyDescriptor,
  getPrototypeOf,
  hasOwn
} from './primordials'
import { pollutedNames } from './prototype-guard'

/** The value of `ExportResultCode.FAILED` in `@opentelemetry/core`. */
const FAILED = 1

/** Marks a base class that is already wrapped, whichever copy of this library wrapped it. */
const MARK = Symbol.for('@bymax-one/nest-telemetry/export-guard')

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
        done({
          code: FAILED,
          error: new ErrorClass(
            'The Object.prototype of this process is polluted, so the batch was dropped.'
          )
        })
        return
      }
      apply(original, this, [items, done])
    }
  })
  defineProperty(base, MARK, { value: true })
}
