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
import { pollutedNames } from './prototype-guard'
import { createUrlQueryRedactor } from './redaction'
import { selectResourceDetectors } from './resource-detectors'
import { settleOptions } from './settle-options'
import type { TelemetryHandle, TelemetryOptions } from './types'
import { warnAboutMissingWinstonTransport } from './winston-transport'

/** Why a start after a shutdown is refused, and what to do instead. */
const RESTART_MESSAGE =
  'Telemetry cannot start again after it was shut down in the same process: the modules the first start instrumented stay patched against its tracer provider, so a second SDK would export nothing for them. Start telemetry once per process; in a test suite, start it once in a global setup.'

/** The handle of a boot that started nothing. */
const DISABLED_HANDLE: TelemetryHandle = {
  enabled: false,
  shutdown: () => Promise.resolve()
}

/**
 * Refuses to start beside a polluted `Object.prototype`: telemetry that cannot be trusted starts nothing and
 * says so with a count, and never throws at the host.
 *
 * @returns `true` when the prototype is polluted, after the warning was attempted: it may not be built.
 */
function refusesPollution(): boolean {
  const polluted = pollutedNames()
  if (polluted === 0) return false
  emitWarning(
    `Telemetry did not start: the Object.prototype of this process holds ${polluted} name(s) that the engine does not define, or holds them changed, and the SDK and its dependencies would read them as settings. Nothing is exported. Remove them, or start telemetry before they are added.`,
    { type: 'SecurityWarning', code: 'BYMAX_TELEMETRY_REALM_POLLUTED' }
  )
  return true
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
export async function startTelemetry(options: TelemetryOptions = {}): Promise<TelemetryHandle> {
  // Each option is read once and its kind checked, and the rest of the call works from the copy, so
  // the warning text and the effect of the call cannot disagree.
  const settled = settleOptions(options)
  const env = readTelemetryEnvironment(settled.env)
  if (settled.enabled === false || env.sdkDisabled) {
    // Turning telemetry off by a later call hands back a disabled handle and leaves a running SDK
    // running.
    if (currentHandle()?.stopping === false || pendingStart()) warnAboutIgnoredOptions(settled)
    return DISABLED_HANDLE
  }
  let running = currentHandle()
  if (running?.stopping === true) {
    // A start that arrives during a flush waits for it, and starts a fresh SDK once it settles.
    // Whether the flush succeeded is its own caller's concern.
    await Promise.allSettled([running.shutdown()])
    running = currentHandle()
  }
  if (running !== undefined) {
    warnAboutIgnoredOptions(settled)
    return running
  }
  // A second caller that arrives while the first is still loading gets the same start, whichever
  // copy of the library it runs in, so two overlapping calls never build two SDKs.
  const joined = pendingStart()
  if (joined !== undefined) {
    warnAboutIgnoredOptions(settled)
    return joined
  }
  if (hasStopped()) {
    emitWarning(RESTART_MESSAGE, {
      type: 'Warning',
      code: 'BYMAX_TELEMETRY_RESTART_UNSUPPORTED'
    })
    throw new Error(RESTART_MESSAGE)
  }
  if (refusesPollution()) return DISABLED_HANDLE
  const start = boot(settled, env).finally(clearPendingStart)
  setPendingStart(start)
  return start
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
 * Loads the OpenTelemetry packages a start needs.
 *
 * @returns The loaded packages.
 */
async function loadPackages(): Promise<LoadedPackages> {
  const [sdkNode, sdkTrace, autoInstrumentations, exporter, resources] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/sdk-trace'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources')
  ])
  return { sdkNode, sdkTrace, autoInstrumentations, exporter, resources }
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
async function boot(
  options: TelemetryOptions,
  env: TelemetryEnvironment
): Promise<TelemetryHandle> {
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
  const packages = await loadPackages()
  // Checked again, with no await between it and the build: a name planted while the packages loaded, and removed
  // before the first export, would otherwise be read by the SDK and its exporters when they are built.
  if (refusesPollution()) return DISABLED_HANDLE
  const sdk = buildSdk(packages, options, env, { instrumentations, unsafe, service })
  sdk.start()
  const handle = createHandle(() => sdk.shutdown(), shutdownTimeoutMs)
  registerHandle(handle)
  return handle
}
