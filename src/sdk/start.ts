/**
 * @fileoverview Starts the OpenTelemetry SDK.
 * @layer sdk
 *
 * No OpenTelemetry package is imported at module scope: every one is loaded by a dynamic `import()`
 * inside the enabled branch, so a disabled boot loads none of them.
 */
import type * as AutoInstrumentations from '@opentelemetry/auto-instrumentations-node'
import type * as OtlpExporter from '@opentelemetry/exporter-trace-otlp-http'
import type * as Resources from '@opentelemetry/resources'
import type * as SdkNode from '@opentelemetry/sdk-node'
import type * as SdkTrace from '@opentelemetry/sdk-trace'

import {
  buildInstrumentationConfig,
  buildResourceAttributes,
  settleInstrumentations,
  settleService,
  settleUnsafe,
  planSignals,
  severFromRootPrototype,
  warnAboutIgnoredOptions,
  warnAboutMissingServiceName,
  warnAboutOversizedTimers,
  warnAboutSamplerName,
  warnAboutSamplerRatio,
  warnAboutUnsafeOptions
} from './assembly'
import type { InstrumentationInputs, ServiceIdentity } from './assembly'
import { emitWarning } from './emit-warning'
import { readRatioSampler, readSamplerNearMiss, readTelemetryEnvironment } from './environment'
import type { TelemetryEnvironment } from './environment'
import { warnOnExportFailure } from './export-failure'
import { guardExports } from './export-guard'
import {
  clearPendingStart,
  createHandle,
  currentHandle,
  hasStopped,
  pendingStart,
  registerHandle,
  setPendingStart
} from './handle'
import type { RunningHandle } from './handle'
import {
  absorbHost,
  absorbOwned,
  ignore,
  ownConstructor,
  resolvedPromise,
  unconsumable
} from './native-promise'
import { create, freeze, isPromise, NativePromise } from './primordials'
import { pollutedNames } from './prototype-guard'
import { createUrlQueryRedactor } from './redaction'
import { selectResourceDetectors } from './resource-detectors'
import { settleOptions } from './settle-options'
import type { TelemetryHandle, TelemetryOptions } from './types'
import { warnAboutMissingWinstonTransport } from './winston-transport'

/** Why a start after a shutdown is refused, and what to do instead. */
const RESTART_MESSAGE =
  'Telemetry cannot start again after it was shut down in the same process: the modules the first start instrumented stay patched against its tracer provider, so a second SDK would export nothing for them. Start telemetry once per process; in a test suite, start it once in a global setup.'

/**
 * The handle of a boot that started nothing. It has no prototype, so a promise that resolves with it reads no `then`
 * from the root prototype, which is polluted when this is the answer to a refusal.
 */
export const DISABLED_HANDLE = create(null) as TelemetryHandle & { enabled: false }
DISABLED_HANDLE.enabled = false
DISABLED_HANDLE.shutdown = (): Promise<void> => resolvedPromise()
freeze(DISABLED_HANDLE)

/**
 * Refuses to start beside a polluted `Object.prototype`: telemetry that cannot be trusted starts nothing and
 * says so with a count, and never throws at the host.
 *
 * @returns `true` when the prototype is polluted, after the warning was attempted: it may not be built.
 */
function refusesPollution(): boolean {
  const polluted = pollutedNames()
  if (polluted === 0) return false
  warnPolluted(polluted)
  return true
}

/**
 * Says that telemetry did not start because the process is polluted.
 *
 * @param polluted - How many names differ from the engine's.
 */
function warnPolluted(polluted: number): void {
  emitWarning(
    `Telemetry did not start: Object.prototype or a built-in the SDK calls differs from the engine's in ${polluted} name(s) (added, missing or changed), and the SDK and its dependencies would read or call them. Nothing is exported. Undo the change, or start telemetry before it is made.`,
    { type: 'SecurityWarning', code: 'BYMAX_TELEMETRY_REALM_POLLUTED' }
  )
}

/**
 * Starts the OpenTelemetry SDK, unless it is disabled.
 *
 * The SDK is off when the host passes `enabled: false` or the standard `OTEL_SDK_DISABLED=true`
 * switch is set, whichever the host says. Starting twice returns the handle already running.
 *
 * @param options - The host's policy.
 * @returns The handle, which flushes and stops the SDK.
 */
export function startTelemetry(options: TelemetryOptions = {}): Promise<TelemetryHandle> {
  // No `async`: returning a handle from one reads a `then` on it, and a promise of ours answers only after a check.
  return ownConstructor(
    new NativePromise<TelemetryHandle>((resolve, reject) => {
      try {
        begin(options, resolve, reject)
      } catch (error) {
        reject(error)
      }
    })
  )
}

/**
 * Hands over a handle, or the disabled one when the process turned polluted: the check is the last thing before the
 * promise reads the handle.
 *
 * @param resolve - Settles the promise of the call.
 * @param handle - The handle to answer with.
 */
function answer(resolve: (handle: TelemetryHandle) => void, handle: TelemetryHandle): void {
  resolve(pollutedNames() > 0 ? DISABLED_HANDLE : handle)
}

/**
 * The first half of a start: the policy of the call, and a wait for a flush that is under way.
 *
 * @param options - The host's policy.
 * @param resolve - Settles the promise of the call.
 * @param reject - Fails the promise of the call.
 */
function begin(
  options: TelemetryOptions,
  resolve: (handle: TelemetryHandle) => void,
  reject: (reason: unknown) => void
): void {
  // Each option is read once and its kind checked, and the rest of the call works from the copy, so
  // the warning text and the effect of the call cannot disagree.
  const settled = settleOptions(options)
  const env = readTelemetryEnvironment(settled.env)
  if (settled.enabled === false || env.sdkDisabled) {
    // Turning telemetry off by a later call hands back a disabled handle and leaves a running SDK
    // running.
    if (currentHandle()?.stopping === false || pendingStart()) warnAboutIgnoredOptions(settled)
    resolve(DISABLED_HANDLE)
    return
  }
  const running = currentHandle()
  if (running?.stopping === true) {
    // A start that arrives during a flush waits for it, and starts a fresh SDK once it settles.
    // Whether the flush succeeded is its own caller's concern.
    const after = (): void => {
      try {
        proceed(settled, env, resolve, reject)
      } catch (error) {
        reject(error)
      }
    }
    if (!absorbHost(running.shutdown(), after, after)) reject(unconsumable())
    return
  }
  proceed(settled, env, resolve, reject)
}

/**
 * The second half of a start: the running handle, the start in progress, or a new boot.
 *
 * @param settled - The options, settled once.
 * @param env - The parsed environment.
 * @param resolve - Settles the promise of the call.
 * @param reject - Fails the promise of the call.
 */
function proceed(
  settled: TelemetryOptions,
  env: TelemetryEnvironment,
  resolve: (handle: TelemetryHandle) => void,
  reject: (reason: unknown) => void
): void {
  const running = currentHandle()
  if (running !== undefined) {
    warnAboutIgnoredOptions(settled)
    answer(resolve, running)
    return
  }
  // A second caller that arrives while the first is still loading gets the same start, whichever
  // copy of the library it runs in, so two overlapping calls never build two SDKs.
  const joined = pendingStart()
  if (joined !== undefined) {
    warnAboutIgnoredOptions(settled)
    const take = (handle: unknown): void => answer(resolve, handle as TelemetryHandle)
    if (!absorbHost(joined, take, reject)) reject(unconsumable())
    return
  }
  if (hasStopped()) {
    emitWarning(RESTART_MESSAGE, {
      type: 'Warning',
      code: 'BYMAX_TELEMETRY_RESTART_UNSUPPORTED'
    })
    throw new Error(RESTART_MESSAGE)
  }
  if (refusesPollution()) {
    resolve(DISABLED_HANDLE)
    return
  }
  // Pinned before it is published: a host accessor on the slot would otherwise see the promise with no own constructor.
  const start = ownConstructor(boot(settled, env))
  setPendingStart(start)
  // The pending start is cleared by a handler of ours, not by `finally`, which would look up `then` on the promise.
  absorbOwned(start, clearPendingStart, clearPendingStart)
  absorbOwned(start, (handle) => answer(resolve, handle as TelemetryHandle), reject)
}

/**
 * Makes the exports of an exporter, and of the others of its base class, refuse a polluted process.
 *
 * @param exporter - An OTLP exporter that was just built.
 * @returns The same exporter.
 */
function guarded<E extends object>(exporter: E): E {
  guardExports(exporter)
  return exporter
}

/** The OpenTelemetry packages a start loads, all of them behind dynamic imports. */
interface LoadedPackages {
  readonly sdkNode: typeof SdkNode
  readonly sdkTrace: typeof SdkTrace
  readonly autoInstrumentations: typeof AutoInstrumentations
  readonly exporter: typeof OtlpExporter
  readonly resources: typeof Resources
}

/**
 * Loads the OpenTelemetry packages a start needs, the five of them at once, and hands them over when the last one
 * arrived.
 *
 * Each import is waited for natively after it took an own constructor, and no `Promise.all`, `then` or
 * constructor that something replaced afterwards can decide what the start gets:
 * a result array handed to `Promise.all` is read for a `then`, which an object that a polluted prototype holds
 * answers. A handler is attached to every import before any of them settles, so none can end the host as an
 * unhandled rejection. The check comes last before the packages are handed over, with nothing between.
 *
 * @param done - Called once with the packages, or with `undefined` when the load cannot be trusted.
 * @param fail - Called once with the first reason an import was refused.
 */
function loadPackages(
  done: (packages: LoadedPackages | undefined) => void,
  fail: (reason: unknown) => void
): void {
  const imports = [
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/sdk-trace'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources')
  ] as const
  const modules = create(null) as Record<number, unknown>
  let waiting = imports.length
  let over = false
  const settle = (): void => {
    // Only reached when every import answered, so no refusal or untrusted import has settled the load before.
    over = true
    done(pollutedNames() > 0 ? undefined : (named(modules) as LoadedPackages))
  }
  for (let at = 0; at < imports.length; at += 1) {
    const source = imports[at]
    if (!isPromise(source)) {
      // Not a promise of the engine's: there is nothing to trust a value from. The others still get their handler.
      if (!over) {
        over = true
        done(undefined)
      }
      continue
    }
    absorbOwned(
      source,
      (module: unknown): void => {
        modules[at] = module
        waiting -= 1
        if (waiting === 0) settle()
      },
      (reason: unknown): void => {
        if (over) return
        over = true
        fail(reason)
      }
    )
  }
}

/**
 * Names the five packages that {@link loadPackages} kept by position.
 *
 * @param modules - The packages by position.
 * @returns The packages by name.
 */
function named(modules: Record<number, unknown>): unknown {
  const result = create(null) as Record<string, unknown>
  result['sdkNode'] = modules[0]
  result['sdkTrace'] = modules[1]
  result['autoInstrumentations'] = modules[2]
  result['exporter'] = modules[3]
  result['resources'] = modules[4]
  return result
}

/** The options that are read once for the whole start. */
type ReadOnce = Pick<InstrumentationInputs, 'instrumentations' | 'unsafe'> & {
  readonly service: ServiceIdentity
}

/**
 * Builds the auto-instrumentations from the settled options, each with the settings it reads cut from
 * the root prototype of the realm.
 *
 * @param packages - The auto-instrumentation package.
 * @param options - The host's policy.
 * @param read - The options that are read once for the whole start.
 * @param signals - The signal plan.
 * @returns The instrumentations.
 */
function buildInstrumentations(
  packages: typeof AutoInstrumentations,
  options: TelemetryOptions,
  read: ReadOnce,
  signals: ReturnType<typeof planSignals>
): ReturnType<typeof AutoInstrumentations.getNodeAutoInstrumentations> {
  const config = buildInstrumentationConfig(
    {
      instrumentations: read.instrumentations,
      unsafe: read.unsafe,
      extraRedactedQueryParams: options.extraRedactedQueryParams,
      ignoreIncomingRequest: options.ignoreIncomingRequest
    },
    signals
  )
  return packages.getNodeAutoInstrumentations(config).map(severFromRootPrototype)
}

/**
 * Builds the SDK from the host's options and the environment, without starting it.
 *
 * @param packages - The loaded OpenTelemetry packages.
 * @param options - The host's policy.
 * @param env - The parsed environment.
 * @param read - The options that are read once for the whole start.
 * @returns The SDK.
 */
function buildSdk(
  packages: LoadedPackages,
  options: TelemetryOptions,
  env: TelemetryEnvironment,
  read: ReadOnce
): SdkNode.NodeSDK {
  const { sdkNode, sdkTrace, autoInstrumentations, exporter, resources } = packages
  const signals = planSignals(env)
  const { instrumentations, unsafe, service } = read
  // No prototype: the SDK reads serviceName, sampler, idGenerator, textMapPropagator and its providers from
  // this object, and a name that a polluted root prototype holds must not be one of them.
  const configuration = Object.assign(Object.create(null) as object, {
    ...signals.overrides,
    resource: resources.resourceFromAttributes(buildResourceAttributes(service, env)),
    resourceDetectors: selectResourceDetectors(
      env.resourceDetectors,
      {
        env: resources.envDetector,
        host: resources.hostDetector,
        os: resources.osDetector,
        process: resources.processDetector,
        serviceinstance: resources.serviceInstanceIdDetector
      },
      {
        keepCommandLine: unsafe?.exportProcessCommandArgs === true,
        keepHostId: unsafe?.exportHostId === true
      }
    ),
    spanProcessors: [
      // Ordered before the batch processor, so each span is redacted in place before it is exported.
      ...(unsafe?.disableUrlRedaction === true ? [] : [createUrlQueryRedactor()]),
      new sdkTrace.BatchSpanProcessor({
        exporter: warnOnExportFailure(
          guarded(new exporter.OTLPTraceExporter()),
          'otlp-http traces'
        ),
        ...env.batchSpanProcessor
      })
    ],
    instrumentations: [buildInstrumentations(autoInstrumentations, options, read, signals)]
  })
  return new sdkNode.NodeSDK(configuration)
}

/**
 * Loads the SDK packages, builds the SDK, starts it and registers its handle.
 *
 * @param options - The host's policy.
 * @param env - The parsed environment.
 * @returns The handle of the started SDK.
 */
function boot(options: TelemetryOptions, env: TelemetryEnvironment): Promise<TelemetryHandle> {
  return new NativePromise<TelemetryHandle>((resolve, reject) => {
    // Read once for the whole start, each field once: a getter, on the option or on a field of it, could
    // answer differently each time, and the warning about a turned-off redaction, the SDK build and the
    // instrumentation config must all see the same values.
    const unsafe = settleUnsafe(options.unsafe)
    const instrumentations = settleInstrumentations(options.instrumentations)
    const service = settleService(options)
    warnAboutUnsafeOptions({ unsafe })
    warnAboutMissingServiceName(service, env)
    warnAboutOversizedTimers(env)
    warnAboutSamplerName(readSamplerNearMiss())
    warnAboutSamplerRatio(readRatioSampler())
    warnAboutMissingWinstonTransport(instrumentations.sendLogs ?? planSignals(env).sendLogs)
    // Read before the SDK starts: an option that throws when read must not leave a started SDK that no
    // handle can stop.
    const shutdownTimeoutMs = options.shutdownTimeoutMs
    // No `await`: the continuation is a callback of the load, so the packages reach it as the load handed them and no
    // promise that something replaced can stand in for it, and the check inside the load is the last before the build.
    loadPackages((packages) => {
      try {
        // Checked again, with no await between it and the build: a name planted while the packages loaded, and
        // removed before the first export, would otherwise be read by the SDK and its exporters when they are built.
        // `packages` is `undefined` when the load itself could not be trusted, and that is a refusal too.
        if (refusesPollution() || packages === undefined) {
          resolve(DISABLED_HANDLE)
          return
        }
        const sdk = buildSdk(packages, options, env, { instrumentations, unsafe, service })
        sdk.start()
        const handle = createHandle(() => sdk.shutdown(), shutdownTimeoutMs)
        registerHandle(handle)
        const turned = pollutedNames()
        if (turned > 0) {
          // The process turned polluted while the SDK was built: the answer is the disabled handle, so nothing could
          // stop the SDK that just started. It is stopped here, and its outcome is nobody's.
          warnPolluted(turned)
          absorbOwned(handle.shutdown(), ignore, ignore)
          resolve(DISABLED_HANDLE)
          return
        }
        resolve(handle)
      } catch (error) {
        reject(error)
      }
    }, reject)
  })
}
