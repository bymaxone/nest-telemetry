/**
 * @fileoverview The logic of the `node --import` preload, kept in TypeScript so it is measured and
 * mutation-tested; the preload file itself is two lines that call it.
 * @layer register
 */
import { register } from 'node:module'

import { readTelemetryEnvironment } from '../sdk/environment'
import { startTelemetry } from '../sdk/start'
import type { TelemetryHandle, TelemetryOptions } from '../sdk/types'

/** The loader hook that lets OpenTelemetry instrument native ES modules. */
export const ESM_HOOK_SPECIFIER = '@opentelemetry/instrumentation/hook.mjs'

/** What the boot depends on, injectable so a test can drive it without a loader or an SDK. */
export interface BootDependencies {
  /** The environment to read. Defaults to the process environment. */
  readonly env?: NodeJS.ProcessEnv
  /** Registers a module loader hook. Defaults to `module.register`. */
  readonly registerHook?: (specifier: string, parentUrl: string) => void
  /** Starts the SDK. Defaults to `startTelemetry`. */
  readonly start?: (options: TelemetryOptions) => Promise<TelemetryHandle>
}

/** The code every warning about the loader hook carries, so an operator can filter on it. */
const HOOK_WARNING_CODE = 'BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE'

/**
 * Starts telemetry from the standard `OTEL_*` variables, for a `node --import` preload.
 *
 * The loader hook is registered first, so native ES modules loaded later are instrumented; a hook
 * that cannot be registered is a warning, not a failure, because CommonJS code is instrumented
 * without it, and so is an SDK that cannot start: tracing must never take down a boot. A disabled
 * boot registers no hook and loads nothing. When the SDK starts, it is flushed as the process runs out of work; signals are the
 * application's to handle.
 *
 * @param parentUrl - URL of the module the loader hook is resolved from.
 * @param dependencies - Replacements for the loader and the SDK start.
 * @returns The handle of the SDK, or a disabled one.
 */
export async function bootFromEnvironment(
  parentUrl: string,
  dependencies: BootDependencies = {}
): Promise<TelemetryHandle> {
  const env = readTelemetryEnvironment(dependencies.env)
  if (!env.sdkDisabled) {
    registerLoaderHook(dependencies.registerHook ?? registerModuleHook, parentUrl)
  }
  const handle = await startOrWarn(
    dependencies.start ?? startTelemetry,
    dependencies.env === undefined ? {} : { env: dependencies.env }
  )
  if (handle.enabled) {
    process.once('beforeExit', () => {
      // Settled, not awaited for its value: a failed flush on exit has nowhere useful to go.
      void Promise.allSettled([handle.shutdown()])
    })
  }
  return handle
}

/**
 * Starts the SDK, turning a failure into a warning and a disabled handle.
 *
 * The preload is a top-level `await`: a failure that escaped here, such as an optional peer that is
 * not installed, would stop Node before the application loads. Tracing must never take down a
 * boot, so the host is told and the application goes on; the programmatic `startTelemetry` keeps
 * its rejection for callers that want it.
 *
 * @param start - Starts the SDK.
 * @param options - The start options.
 * @returns The handle of the SDK, or a disabled one.
 */
async function startOrWarn(
  start: (options: TelemetryOptions) => Promise<TelemetryHandle>,
  options: TelemetryOptions
): Promise<TelemetryHandle> {
  try {
    return await start(options)
  } catch (error) {
    process.emitWarning(
      `Telemetry could not be started (${String(error)}), so the application continues without it.`,
      { type: 'Warning', code: 'BYMAX_TELEMETRY_START_FAILED' }
    )
    return { enabled: false, shutdown: () => Promise.resolve() }
  }
}

/**
 * Registers the loader hook, turning a failure into a warning.
 *
 * @param register - Registers a loader hook.
 * @param parentUrl - URL of the module the hook is resolved from.
 */
function registerLoaderHook(
  register: (specifier: string, parentUrl: string) => void,
  parentUrl: string
): void {
  try {
    register(ESM_HOOK_SPECIFIER, parentUrl)
  } catch (error) {
    process.emitWarning(
      `The OpenTelemetry loader hook could not be registered (${String(error)}), so native ES modules are not instrumented. Install @opentelemetry/instrumentation to instrument them; CommonJS code is unaffected.`,
      { type: 'Warning', code: HOOK_WARNING_CODE }
    )
  }
}

/**
 * The default loader-hook registration: `module.register`.
 *
 * @param specifier - The hook module.
 * @param parentUrl - URL the specifier is resolved from.
 */
function registerModuleHook(specifier: string, parentUrl: string): void {
  register(specifier, parentUrl)
}
