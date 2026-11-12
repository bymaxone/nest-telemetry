/**
 * @fileoverview The one place the library reads environment variables.
 * @layer sdk
 *
 * Every other module receives its environment as a parameter. The OTel SDK reads
 * `OTEL_EXPORTER_OTLP_*`, `OTEL_TRACES_SAMPLER*` and `OTEL_RESOURCE_ATTRIBUTES` itself, and the
 * library never touches them.
 */

/** Batch-span-processor tuning, present only for the variables that hold a usable value. */
export interface BatchSpanProcessorTuning {
  /** Spans held before new ones are dropped (`OTEL_BSP_MAX_QUEUE_SIZE`). */
  maxQueueSize?: number
  /** Milliseconds between two exports (`OTEL_BSP_SCHEDULE_DELAY`). */
  scheduledDelayMillis?: number
  /** Milliseconds an export may run before it times out (`OTEL_BSP_EXPORT_TIMEOUT`). */
  exportTimeoutMillis?: number
  /** Spans sent in one export (`OTEL_BSP_MAX_EXPORT_BATCH_SIZE`). */
  maxExportBatchSize?: number
}

/** The environment values the library acts on. */
export interface TelemetryEnvironment {
  /** Whether `OTEL_SDK_DISABLED` is the word `true`, in any letter case. */
  readonly sdkDisabled: boolean
  /** `OTEL_SERVICE_NAME`, or `undefined` when it is unset or blank. */
  readonly serviceName: string | undefined
  /** Names in `OTEL_METRICS_EXPORTER`. */
  readonly metricsExporters: readonly string[]
  /** Names in `OTEL_LOGS_EXPORTER`. */
  readonly logsExporters: readonly string[]
  /** The `OTEL_BSP_*` values mapped onto the batch span processor. */
  readonly batchSpanProcessor: BatchSpanProcessorTuning
  /** Names in `OTEL_NODE_RESOURCE_DETECTORS`, or `undefined` when it is unset or blank. */
  readonly resourceDetectors: readonly string[] | undefined
}

/**
 * Splits an exporter-list variable the way the SDK does: comma-separated, trimmed, blanks dropped.
 *
 * @param raw - The unparsed variable.
 * @returns The exporter names.
 */
function readExporterList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
}

/**
 * Reads one `OTEL_BSP_*` value: blank, non-numeric, non-positive and infinite values are ignored,
 * so the SDK default applies.
 *
 * @param raw - The unparsed variable.
 * @returns The positive finite number, or `undefined` when the value is unusable.
 */
function readPositiveNumber(raw: string | undefined): number | undefined {
  // `Number` maps an unset or blank value to `NaN` or `0`, so the one guard covers every case.
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Reads the environment values the library acts on.
 *
 * @param source - The environment to read. Defaults to the process environment.
 * @returns The parsed values.
 */
export function readTelemetryEnvironment(
  source: NodeJS.ProcessEnv = process.env
): TelemetryEnvironment {
  const tuning: BatchSpanProcessorTuning = {}
  const maxQueueSize = readPositiveNumber(source['OTEL_BSP_MAX_QUEUE_SIZE'])
  if (maxQueueSize !== undefined) tuning.maxQueueSize = maxQueueSize
  const scheduledDelayMillis = readPositiveNumber(source['OTEL_BSP_SCHEDULE_DELAY'])
  if (scheduledDelayMillis !== undefined) tuning.scheduledDelayMillis = scheduledDelayMillis
  const exportTimeoutMillis = readPositiveNumber(source['OTEL_BSP_EXPORT_TIMEOUT'])
  if (exportTimeoutMillis !== undefined) tuning.exportTimeoutMillis = exportTimeoutMillis
  const maxExportBatchSize = readPositiveNumber(source['OTEL_BSP_MAX_EXPORT_BATCH_SIZE'])
  if (maxExportBatchSize !== undefined) tuning.maxExportBatchSize = maxExportBatchSize
  const serviceName = source['OTEL_SERVICE_NAME']?.trim()
  const detectors = source['OTEL_NODE_RESOURCE_DETECTORS']
  return {
    sdkDisabled: source['OTEL_SDK_DISABLED']?.toLowerCase() === 'true',
    serviceName: serviceName === '' ? undefined : serviceName,
    metricsExporters: readExporterList(source['OTEL_METRICS_EXPORTER']),
    logsExporters: readExporterList(source['OTEL_LOGS_EXPORTER']),
    batchSpanProcessor: tuning,
    resourceDetectors:
      detectors === undefined || detectors.trim() === '' ? undefined : readExporterList(detectors)
  }
}
