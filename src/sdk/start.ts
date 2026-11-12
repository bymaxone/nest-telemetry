/**
 * @fileoverview Starts the OpenTelemetry SDK.
 * @layer sdk
 *
 * No OpenTelemetry package is imported at module scope: every one is loaded by a dynamic `import()`
 * inside the enabled branch, so a disabled boot loads none of them.
 */
import {
  buildInstrumentationConfig,
  buildResourceAttributes,
  planSignals,
  warnAboutUnsafeOptions
} from './assembly'
import { readTelemetryEnvironment } from './environment'
import type { TelemetryEnvironment } from './environment'
import { clearHandle, currentHandle, registerHandle } from './handle'
import { createUrlQueryRedactor } from './redaction'
import { selectResourceDetectors } from './resource-detectors'
import type { TelemetryHandle, TelemetryOptions } from './types'

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
    return DISABLED_HANDLE
  }
  const running = currentHandle()
  if (running !== undefined) {
    return running
  }
  // A second caller that arrives while the first is still loading gets the same start, so two
  // overlapping calls never build two SDKs.
  starting ??= boot(options, env).finally(() => {
    starting = undefined
  })
  return starting
}

/** The start in progress, if any. */
let starting: Promise<TelemetryHandle> | undefined

/**
 * Loads the SDK packages, builds the SDK and starts it.
 *
 * @param options - The host's policy.
 * @param env - The parsed environment.
 * @returns The handle of the started SDK.
 */
async function boot(
  options: TelemetryOptions,
  env: TelemetryEnvironment
): Promise<TelemetryHandle> {
  warnAboutUnsafeOptions(options)

  const [
    { NodeSDK },
    { BatchSpanProcessor },
    { getNodeAutoInstrumentations },
    exporter,
    resources
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/sdk-trace'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources')
  ])

  const signals = planSignals(env)
  const sdk = new NodeSDK({
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
      new BatchSpanProcessor({
        exporter: new exporter.OTLPTraceExporter(),
        ...env.batchSpanProcessor
      })
    ],
    instrumentations: [getNodeAutoInstrumentations(buildInstrumentationConfig(options, signals))]
  })
  sdk.start()

  let stopped = false
  const handle: TelemetryHandle = {
    enabled: true,
    shutdown: async () => {
      if (stopped) {
        return
      }
      stopped = true
      if (currentHandle() === handle) {
        clearHandle()
      }
      await sdk.shutdown()
    }
  }
  registerHandle(handle)
  return handle
}
