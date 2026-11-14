/**
 * @fileoverview The route a library warning takes to a structured logger, with the process warning as the fallback.
 * @layer sdk
 *
 * The SDK entry and the preload import no Nest package, and the preload is a separate copy of this
 * code from the application's, so the two share one optional sink through `globalThis`, under a
 * registry symbol, as they share the handle. With no sink registered a warning is emitted as a
 * process warning.
 */

/** A warning the library reports. */
export interface TelemetryWarning {
  /** The stable code, such as `BYMAX_TELEMETRY_EXPORT_FAILED`. */
  readonly code: string
  /** The text of the process warning. */
  readonly text: string
  /** Structured values a logger can carry, never a message, an endpoint or a payload. */
  readonly fields?: Readonly<Record<string, string | number>>
}

/** Takes a warning and returns whether it handled it, so a declined warning is still a process warning. */
export type WarningSink = (warning: TelemetryWarning) => boolean

/** The registry symbol under which the sink is published. */
const SINK_KEY = Symbol.for('@bymax-one/nest-telemetry/warning-sink')

/**
 * Registers the sink warnings are routed through, replacing any other.
 *
 * @param sink - The sink.
 * @returns A function that removes this sink, and only this one: a sink another module registered
 *   since stays in place.
 */
export function registerWarningSink(sink: WarningSink): () => void {
  Reflect.set(globalThis, SINK_KEY, sink)
  return () => {
    if (Reflect.get(globalThis, SINK_KEY) === sink) {
      Reflect.deleteProperty(globalThis, SINK_KEY)
    }
  }
}

/** Removes whatever sink is registered, for a test harness. */
export function clearWarningSink(): void {
  Reflect.deleteProperty(globalThis, SINK_KEY)
}

/**
 * Reports a warning through the registered sink, or as a process warning when there is none, the
 * sink declines or the sink throws. It never throws: its callers are an exporter callback and a
 * flush.
 *
 * @param warning - The warning.
 */
export function reportWarning(warning: TelemetryWarning): void {
  try {
    const sink = Reflect.get(globalThis, SINK_KEY) as WarningSink | undefined
    if (sink?.(warning) === true) {
      return
    }
  } catch {
    // A failing sink falls through to the process warning below.
  }
  process.emitWarning(warning.text, { type: 'Warning', code: warning.code })
}
