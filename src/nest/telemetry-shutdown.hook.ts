/**
 * @fileoverview Flushes the OpenTelemetry SDK on application shutdown.
 * @layer nest
 */
import { Inject, Injectable, Logger } from '@nestjs/common'
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'

import { shutdownTelemetry } from '../sdk/handle'
import { registerWarningSink } from '../sdk/warning-sink'
import type { TelemetryWarning } from '../sdk/warning-sink'

/** Log key of the entry a failed flush leaves, stable so an alert can match it. */
export const TELEMETRY_FLUSH_FAILED_KEY = 'TRACING_FLUSH_FAILED'

/** Log key of the entry a shutdown that hit its deadline leaves, stable so an alert can match it. */
export const TELEMETRY_SHUTDOWN_TIMEOUT_KEY = 'TRACING_SHUTDOWN_TIMEOUT'

/** Log key of the entry a failed span export leaves, stable so an alert can match it. */
export const TELEMETRY_EXPORT_FAILED_KEY = 'TRACING_EXPORT_FAILED'

/** Injection token of the optional structured logger a failed flush is reported through. */
export const TELEMETRY_LOGGER = Symbol('TELEMETRY_LOGGER')

/** The one call the hook makes on a structured logger. */
export interface ITelemetryErrorLogger {
  /**
   * Writes an error entry under a log key.
   *
   * @param logKey - The entry's log key.
   * @param error - The failure.
   */
  errorStructured(logKey: string, error: Error): void

  /**
   * Writes a warning entry under a log key, for a failed span export. Optional: a logger without
   * it gets that warning as a process warning.
   *
   * @param logKey - The entry's log key.
   * @param message - The library's own text, never anything from the exporter.
   * @param userId - Always `undefined`.
   * @param metadata - The exporter kind and a short error code.
   */
  warnStructured?(
    logKey: string,
    message: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ): void
}

/** What the hook needs of Nest's module reference: to look a provider up anywhere in the application. */
export interface IProviderLookup {
  /**
   * Resolves a provider by token, throwing when there is none.
   *
   * @param token - The injection token.
   * @param options - Looks beyond the hook's own module.
   */
  get(token: symbol, options: { strict: false }): unknown
}

/** Awaits the SDK flush as part of the application's own graceful shutdown. */
@Injectable()
export class TelemetryShutdownHook implements OnApplicationShutdown, OnModuleInit {
  /** Removes this hook's warning sink, when it registered one. */
  private releaseSink: (() => void) | undefined

  /**
   * @param moduleRef - Resolves the optional structured logger when a flush fails.
   */
  public constructor(@Inject(ModuleRef) private readonly moduleRef: IProviderLookup) {}

  /**
   * Routes the library's two runtime warnings to the structured logger the application bound, when
   * there is one. Without it they stay process warnings.
   */
  public onModuleInit(): void {
    if (this.structuredLogger() !== undefined) {
      this.releaseSink = registerWarningSink((warning) => this.route(warning))
    }
  }

  /**
   * Flushes and stops the SDK, if one was started.
   *
   * Nest awaits this while closing the application, so awaiting the flush here guarantees buffered
   * spans are exported before the process exits. A flush the collector refuses, or one the batch
   * processor abandons after its export timeout, is reported and ends there: an orchestrator reads
   * the exit code, and a collector outage is not a crashed instance.
   *
   * @returns A promise that resolves once buffered spans are exported, or once a failed export
   *   has been reported. Never rejects.
   */
  public async onApplicationShutdown(): Promise<void> {
    try {
      await shutdownTelemetry()
    } catch (error: unknown) {
      this.report(error)
    } finally {
      this.releaseSink?.()
    }
  }

  /**
   * Writes a warning to the structured logger under its key.
   *
   * @param warning - The warning.
   * @returns Whether the logger took it; a warning with no key or no method on the logger is left
   *   to the process warning.
   */
  private route(warning: TelemetryWarning): boolean {
    const logger = this.structuredLogger()
    if (
      warning.code === 'BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT' &&
      typeof logger?.errorStructured === 'function'
    ) {
      logger.errorStructured(TELEMETRY_SHUTDOWN_TIMEOUT_KEY, new Error(warning.text))
      return true
    }
    if (
      warning.code === 'BYMAX_TELEMETRY_EXPORT_FAILED' &&
      typeof logger?.warnStructured === 'function'
    ) {
      logger.warnStructured(TELEMETRY_EXPORT_FAILED_KEY, warning.text, undefined, {
        ...warning.fields
      })
      return true
    }
    return false
  }

  /**
   * Reports a failed flush: through the structured logger when the application provides a usable
   * one, else through the Nest logger with the key in the message. Reporting is itself guarded at
   * every step, because the hook's one job is to keep shutdown from failing: a logger the
   * application bound to the token that is the wrong value, or that throws, falls through to the
   * Nest logger, and a Nest logger that throws ends the report.
   *
   * @param error - The rejection. A value that is not an `Error` is not stringified, since its
   *   `toString` could throw here.
   */
  private report(error: unknown): void {
    const failure =
      error instanceof Error ? error : new Error('The telemetry SDK failed to shut down.')
    try {
      const logger = this.structuredLogger()
      if (typeof logger?.errorStructured === 'function') {
        logger.errorStructured(TELEMETRY_FLUSH_FAILED_KEY, failure)
        return
      }
    } catch {
      // Falls through to the Nest logger below.
    }
    try {
      new Logger('Telemetry').error(
        `${TELEMETRY_FLUSH_FAILED_KEY}: ${failure.message}`,
        failure.stack
      )
    } catch {
      // Nothing is left to report through, and the shutdown must still not fail.
    }
  }

  /**
   * Looks the structured logger up.
   *
   * @returns The logger, or `undefined` when the application provides none.
   */
  private structuredLogger(): ITelemetryErrorLogger | undefined {
    try {
      return this.moduleRef.get(TELEMETRY_LOGGER, { strict: false }) as ITelemetryErrorLogger
    } catch {
      return undefined
    }
  }
}
