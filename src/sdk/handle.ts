/**
 * @fileoverview The process-wide handle the preload registers and the application drains.
 * @layer sdk
 *
 * The preload and the application are separate module graphs: one loaded through `--import`, the
 * other through the entry point. They share no module state, only `globalThis`, so the handle lives
 * there under a registry symbol that no application key can collide with.
 */
import type { TelemetryHandle } from './types'

/** The registry symbol under which the handle is published. */
const HANDLE_KEY = Symbol.for('@bymax-one/nest-telemetry/handle')

/** `globalThis` seen as the store of the handle. */
const store = globalThis as typeof globalThis & { [HANDLE_KEY]?: TelemetryHandle }

/**
 * Registers a started SDK's handle.
 *
 * @param handle - The handle to publish.
 */
export function registerHandle(handle: TelemetryHandle): void {
  store[HANDLE_KEY] = handle
}

/**
 * Reads the registered handle.
 *
 * @returns The handle, or `undefined` when none is registered.
 */
export function currentHandle(): TelemetryHandle | undefined {
  return store[HANDLE_KEY]
}

/** Clears the registered handle. */
export function clearHandle(): void {
  delete store[HANDLE_KEY]
}

/**
 * Flushes and stops the SDK the preload registered, if any.
 *
 * Awaiting this guarantees buffered spans are exported before the process exits. With nothing
 * registered, which is the case when telemetry is disabled, it resolves immediately.
 *
 * @returns A promise that resolves once buffered spans are exported.
 */
export async function shutdownTelemetry(): Promise<void> {
  await currentHandle()?.shutdown()
}
