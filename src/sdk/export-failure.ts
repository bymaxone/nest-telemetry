/**
 * @fileoverview Makes a failed span export visible without leaking what was exported.
 * @layer sdk
 *
 * The batch processor drops a batch the collector does not accept and reports the failure only
 * through the OpenTelemetry diagnostic logger, which is off by default, so a collector that is down
 * or refuses every export leaves the application silent. This wraps the exporter's `export` to
 * report one warning, at most once a minute, naming the exporter and a short error code. Every
 * failed export is also counted, with no limit, for the metrics contributor.
 *
 * Only the trace exporter is wrapped. A wrapper for a logs exporter must not report through the
 * warning sink: a bound logger can forward its records to OTLP logs, so a failed logs export would
 * be reported by writing a record that exports as logs and can fail in turn.
 */

import { reportWarning } from './warning-sink'

/** What an export hands its callback: `code` is 0 for success, anything else is a failure. */
export interface ExportOutcome {
  readonly code: number
  readonly error?: unknown
}

/** The part of a span exporter this module watches. */
export interface ObservableExporter {
  export(spans: readonly unknown[], done: (result: ExportOutcome) => void): void
}

/** The shortest time between two warnings. */
const WINDOW_MS = 60_000

/** The registry symbol under which the count of failed exports is published. */
const COUNT_KEY = Symbol.for('@bymax-one/nest-telemetry/export-failures')

/**
 * Reads how many span exports have failed in this process, whichever copy of the library wrapped
 * the exporter: the count lives on `globalThis`, as the handle and the warning sink do.
 *
 * @returns The number of failed exports since the process started.
 */
export function exportFailureCount(): number {
  const count = Reflect.get(globalThis, COUNT_KEY)
  return typeof count === 'number' ? count : 0
}

/** The value of `ExportResultCode.SUCCESS` in `@opentelemetry/core`. */
const SUCCESS = 0

/** What a code may look like to be named in a warning: an upper-case token, never free text. */
const CODE_TOKEN = /^[A-Z0-9_]{1,40}$/

/** Reads a short code from an error, or `UNKNOWN`: the message and payload are never read. */
function codeOf(error: unknown): string {
  const code = String(Reflect.get(Object(error), 'code'))
  return CODE_TOKEN.test(code) ? code : 'UNKNOWN'
}

/**
 * Wraps an exporter so a failed export emits `BYMAX_TELEMETRY_EXPORT_FAILED`, at most once per
 * minute, and returns the same exporter.
 *
 * @param exporter - The exporter to watch, changed in place.
 * @param kind - What the exporter is, named in the warning.
 * @param clock - The time source in milliseconds, monotonic by default so a step of the wall clock cannot stretch or shorten the window; replaced in tests.
 * @returns The exporter that was passed.
 */
export function warnOnExportFailure<E extends ObservableExporter>(
  exporter: E,
  kind: string,
  clock: () => number = () => performance.now()
): E {
  const original = exporter.export.bind(exporter)
  let lastWarning = Number.NEGATIVE_INFINITY
  exporter.export = (spans, done): void => {
    original(spans, (result) => {
      if (result.code !== SUCCESS) {
        // Counted before the warning window, so a collector that stays down keeps counting.
        Reflect.set(globalThis, COUNT_KEY, exportFailureCount() + 1)
      }
      if (result.code !== SUCCESS && clock() - lastWarning >= WINDOW_MS) {
        lastWarning = clock()
        try {
          const code = codeOf(result.error)
          reportWarning({
            code: 'BYMAX_TELEMETRY_EXPORT_FAILED',
            text: `Exporting spans failed (${kind}, code ${code}), so the batch was dropped. This warning repeats at most once a minute. Check that the collector is reachable.`,
            fields: { kind, code }
          })
        } catch {
          // A diagnostic never changes what the SDK is told about the export.
        }
      }
      done(result)
    })
  }
  return exporter
}
