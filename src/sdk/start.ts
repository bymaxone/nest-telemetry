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
  planSignals,
  warnAboutIgnoredOptions,
  warnAboutMissingServiceName,
  warnAboutUnsafeOptions
} from './assembly'
import { readTelemetryEnvironment } from './environment'
import type { TelemetryEnvironment } from './environment'
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
import { createUrlQueryRedactor } from './redaction'
import { selectResourceDetectors } from './resource-detectors'
import type { TelemetryHandle, TelemetryOptions } from './types'

/** Why a start after a shutdown is refused, and what to do instead. */
const RESTART_MESSAGE =
  'Telemetry cannot start again after it was shut down in the same process: the modules the first start instrumented stay patched against its tracer provider, so a second SDK would export nothing for them. Start telemetry once per process; in a test suite, start it once in a global setup.'

/** The handle of a boot that started nothing. */
const DISABLED_HANDLE: TelemetryHandle = {
  enabled: false,
  shutdown: () => Promise.resolve()
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
  const env = readTelemetryEnvironment(options.env)
  if (options.enabled === false || env.sdkDisabled) {
    // Turning telemetry off by a later call hands back a disabled handle and leaves a running SDK
    // running.
    if (currentHandle()?.stopping === false || pendingStart()) warnAboutIgnoredOptions(options)
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
    warnAboutIgnoredOptions(options)
    return running
  }
  // A second caller that arrives while the first is still loading gets the same start, whichever
  // copy of the library it runs in, so two overlapping calls never build two SDKs.
  const joined = pendingStart()
  if (joined !== undefined) {
    warnAboutIgnoredOptions(options)
    return joined
  }
  if (hasStopped()) {
    process.emitWarning(RESTART_MESSAGE, {
      type: 'Warning',
      code: 'BYMAX_TELEMETRY_RESTART_UNSUPPORTED'
    })
    throw new Error(RESTART_MESSAGE)
  }
  const start = boot(options, env).finally(clearPendingStart)
  setPendingStart(start)
  return start
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

/**
 * Builds the SDK from the host's options and the environment, without starting it.
 *
 * @param packages - The loaded OpenTelemetry packages.
 * @param options - The host's policy.
 * @param env - The parsed environment.
 * @returns The SDK.
 */
function buildSdk(
  packages: LoadedPackages,
  options: TelemetryOptions,
  env: TelemetryEnvironment
): SdkNode.NodeSDK {
  const { sdkNode, sdkTrace, autoInstrumentations, exporter, resources } = packages
  const signals = planSignals(env)
  return new sdkNode.NodeSDK({
    ...signals.overrides,
    resource: resources.resourceFromAttributes(buildResourceAttributes(options, env)),
    resourceDetectors: selectResourceDetectors(
      env.resourceDetectors,
      {
        env: resources.envDetector,
        host: resources.hostDetector,
        os: resources.osDetector,
        process: resources.processDetector,
        serviceinstance: resources.serviceInstanceIdDetector
      },
      options.unsafe?.exportProcessCommandArgs === true
    ),
    spanProcessors: [
      // Ordered before the batch processor, so each span is redacted in place before it is exported.
      ...(options.unsafe?.disableUrlRedaction === true ? [] : [createUrlQueryRedactor()]),
      new sdkTrace.BatchSpanProcessor({
        exporter: new exporter.OTLPTraceExporter(),
        ...env.batchSpanProcessor
      })
    ],
    instrumentations: [
      autoInstrumentations.getNodeAutoInstrumentations(buildInstrumentationConfig(options, signals))
    ]
  })
}

/**
 * Loads the SDK packages, builds the SDK, starts it and registers its handle.
 *
 * @param options - The host's policy.
 * @param env - The parsed environment.
 * @returns The handle of the started SDK.
 */
async function boot(options: TelemetryOptions, env: TelemetryEnvironment): Promise<RunningHandle> {
  warnAboutUnsafeOptions(options)
  warnAboutMissingServiceName(options, env)
  const sdk = buildSdk(await loadPackages(), options, env)
  sdk.start()
  const handle = createHandle(() => sdk.shutdown())
  registerHandle(handle)
  return handle
}
