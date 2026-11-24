/**
 * @fileoverview The process-wide handle the preload registers and the application drains.
 * @layer sdk
 *
 * The preload and the application are separate module graphs: one loaded through `--import`, the
 * other through the entry point. They share no module state, only `globalThis`, so the handle lives
 * there under a registry symbol that no application key can collide with.
 */
import { absorbHost, absorbOwned, ownConstructor, resolvedPromise } from './native-promise'
import { create, defineProperty, NativePromise } from './primordials'
import type { TelemetryHandle } from './types'
import { reportWarning } from './warning-sink'

/** A registered handle, which also knows whether its shutdown is under way. */
export interface RunningHandle extends TelemetryHandle {
  /** Whether a shutdown has begun and has not yet settled. */
  readonly stopping: boolean
}

/** The registry symbol under which the handle is published. */
const HANDLE_KEY = Symbol.for('@bymax-one/nest-telemetry/handle')

/** The registry symbol under which the start in progress is published. */
const PENDING_KEY = Symbol.for('@bymax-one/nest-telemetry/pending-start')

/** The registry symbol under which the fact that an SDK was shut down is published. */
const STOPPED_KEY = Symbol.for('@bymax-one/nest-telemetry/stopped')

/** `globalThis` seen as the store of the handle and of the start in progress. */
const store = globalThis as typeof globalThis & {
  [HANDLE_KEY]?: RunningHandle
  [PENDING_KEY]?: Promise<TelemetryHandle>
}

/**
 * Registers a started SDK's handle.
 *
 * @param handle - The handle to publish.
 */
export function registerHandle(handle: RunningHandle): void {
  store[HANDLE_KEY] = handle
}

/**
 * Reads the registered handle.
 *
 * @returns The handle, or `undefined` when none is registered.
 */
export function currentHandle(): RunningHandle | undefined {
  return store[HANDLE_KEY]
}

/**
 * Reads whether an SDK this process started has been shut down.
 *
 * @returns `true` once a started SDK has finished shutting down, whether or not its flush failed.
 */
export function hasStopped(): boolean {
  return Reflect.get(globalThis, STOPPED_KEY) === true
}

/** Clears the registered handle and the mark that an SDK was shut down, for a test harness. */
export function clearHandle(): void {
  delete store[HANDLE_KEY]
  Reflect.deleteProperty(globalThis, STOPPED_KEY)
}

/**
 * Reads the start in progress, if any.
 *
 * Kept beside the handle, under its own registry symbol, so that two copies of the library, such as
 * an ESM preload and a CommonJS application, join one start instead of each beginning their own.
 *
 * @returns The pending start, or `undefined` when none is under way.
 */
export function pendingStart(): Promise<TelemetryHandle> | undefined {
  return store[PENDING_KEY]
}

/**
 * Publishes the start in progress.
 *
 * @param start - The pending start.
 */
export function setPendingStart(start: Promise<TelemetryHandle>): void {
  store[PENDING_KEY] = start
}

/** Clears the start in progress. */
export function clearPendingStart(): void {
  delete store[PENDING_KEY]
}

/** The shutdown deadline used when the host gives none, or gives a value that cannot be used. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000

/** The largest shutdown deadline a host may ask for; above it the default applies. */
const MAX_SHUTDOWN_TIMEOUT_MS = 120_000

/** Reads the deadline, falling back to the default for anything that is not a usable duration. */
function shutdownDeadline(requested: number | undefined): number {
  return requested !== undefined &&
    Number.isFinite(requested) &&
    requested > 0 &&
    requested <= MAX_SHUTDOWN_TIMEOUT_MS
    ? requested
    : DEFAULT_SHUTDOWN_TIMEOUT_MS
}

/**
 * Stops the SDK, bounded by a deadline.
 *
 * @param stopSdk - Stops the SDK.
 * @param shutdownTimeoutMs - The host's deadline, or `undefined`.
 * @param finish - Marks the shutdown finished, once the SDK stopped or the deadline passed.
 * @returns A promise that settles when the shutdown does.
 */
function beginFlush(
  stopSdk: () => Promise<void>,
  shutdownTimeoutMs: number | undefined,
  finish: () => void
): Promise<void> {
  return ownConstructor(
    new NativePromise<void>((resolve, reject) => {
      const deadline = shutdownDeadline(shutdownTimeoutMs)
      const timer = setTimeout(() => {
        reportWarning({
          code: 'BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT',
          text: `The telemetry flush did not finish within ${deadline} ms, so shutdown stopped waiting for it. Spans still queued may be lost. Raise shutdownTimeoutMs or check that the collector answers.`,
          fields: { timeoutMs: deadline }
        })
        finish()
        resolve()
      }, deadline)
      timer.unref()
      const stopped = (): void => {
        clearTimeout(timer)
        finish()
      }
      absorbOwned(
        new NativePromise<void>((started) => {
          started(stopSdk())
        }),
        () => {
          stopped()
          resolve()
        },
        (reason) => {
          stopped()
          reject(reason)
        }
      )
    })
  )
}

/**
 * Creates the handle of a started SDK.
 *
 * Every caller of `shutdown` gets the one flush: a caller that arrives while it is pending waits for
 * it, so awaiting `shutdown` means the spans were exported, whoever started the flush, unless the deadline below passed first. The
 * handle stays registered until the flush settles, so `shutdownTelemetry` finds it too, and clears
 * its own registration then, success or failure, leaving a handle another copy registered alone.
 *
 * A flush that has not finished by the deadline stops holding the caller: `shutdown` warns and
 * resolves, so a collector that accepts a connection and never answers cannot spend a container's
 * termination grace period. The flush itself keeps running in the background, and a failure that
 * arrives after the deadline is dropped, because nobody is waiting for it.
 *
 * @param stopSdk - Flushes and stops the SDK.
 * @param shutdownTimeoutMs - The deadline in milliseconds; 5000 when absent, not a finite number
 * above zero, or above 120000.
 * @returns The handle.
 */
export function createHandle(
  stopSdk: () => Promise<void>,
  shutdownTimeoutMs?: number
): RunningHandle {
  let flush: Promise<void> | undefined
  let finished = false
  // No prototype: a promise that resolves with the handle reads no `then` from the root prototype.
  const handle = create(null) as {
    enabled: boolean
    stopping: boolean
    shutdown: () => Promise<void>
  }
  defineProperty(handle, 'stopping', {
    __proto__: null,
    enumerable: true,
    get: (): boolean => flush !== undefined && !finished
  } as PropertyDescriptor)
  handle.enabled = true
  handle.shutdown = (): Promise<void> => {
    if (finished) {
      return resolvedPromise()
    }
    flush ??= beginFlush(stopSdk, shutdownTimeoutMs, () => {
      finished = true
      Reflect.set(globalThis, STOPPED_KEY, true)
      if (currentHandle() === handle) {
        Reflect.deleteProperty(globalThis, HANDLE_KEY)
      }
    })
    return flush
  }
  return handle
}

/**
 * Flushes and stops the SDK the preload registered, if any.
 *
 * Awaiting this guarantees buffered spans are exported before the process exits, including when
 * another caller started the flush or the start is still in progress. With nothing registered, which is the case when telemetry is
 * disabled, it resolves immediately.
 *
 * @returns A promise that resolves once buffered spans are exported.
 */
export function shutdownTelemetry(): Promise<void> {
  // No `async`: a caller awaits a promise that carries its own constructor, and nothing is read from a handle's promise.
  return ownConstructor(
    new NativePromise<void>((resolve, reject) => {
      const drain = (): void => {
        try {
          const handle = currentHandle()
          if (handle === undefined || !absorbHost(handle.shutdown(), () => resolve(), reject))
            resolve()
        } catch (error) {
          reject(error)
        }
      }
      const pending = pendingStart()
      // A start still loading the packages has no handle to drain yet. Wait for it, so the SDK it builds is
      // stopped rather than left running; whether the start succeeded is its caller's concern.
      if (pending === undefined || !absorbHost(pending, drain, drain)) drain()
    })
  )
}
