/**
 * @fileoverview Flushes the OpenTelemetry SDK on application shutdown.
 * @layer nest
 */
import { Inject, Injectable, Logger } from '@nestjs/common'
import type { OnApplicationShutdown } from '@nestjs/common'
import { ModuleRef } from '@nestjs/core'

import { shutdownTelemetry } from '../sdk/handle'

/** Log key of the entry a failed flush leaves, stable so an alert can match it. */
export const TELEMETRY_FLUSH_FAILED_KEY = 'TRACING_FLUSH_FAILED'

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
export class TelemetryShutdownHook implements OnApplicationShutdown {
  /**
   * @param moduleRef - Resolves the optional structured logger when a flush fails.
   */
  public constructor(@Inject(ModuleRef) private readonly moduleRef: IProviderLookup) {}

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
    }
  }

  /**
   * Reports a failed flush: through the structured logger when the application provides one, else
   * through the Nest logger with the key in the message.
   *
   * @param error - The rejection. A value that is not an `Error` is not stringified, since its
   *   `toString` could throw here, inside the one place whose job is to keep shutdown from failing.
   */
  private report(error: unknown): void {
    const failure =
      error instanceof Error ? error : new Error('The telemetry SDK failed to shut down.')
    const logger = this.structuredLogger()
    if (logger === undefined) {
      new Logger('Telemetry').error(
        `${TELEMETRY_FLUSH_FAILED_KEY}: ${failure.message}`,
        failure.stack
      )
    } else {
      logger.errorStructured(TELEMETRY_FLUSH_FAILED_KEY, failure)
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
