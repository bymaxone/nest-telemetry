/**
 * @fileoverview Tests the checks `startTelemetry` runs on the environment before it builds the SDK: the
 * winston transport check and the sampler ratio check, each with the SDK packages replaced by doubles.
 * @layer sdk
 */
import { clearHandle, clearPendingStart } from './handle'
import { startTelemetry } from './start'

const mockSdkInstance = {
  start: jest.fn<void, []>(),
  shutdown: jest.fn<Promise<void>, []>()
}
const mockNodeSdk = jest.fn((..._args: unknown[]) => mockSdkInstance)
const mockAutoInstrumentations = jest.fn((..._args: unknown[]) => ['instrumentation'])
const mockWinstonTransportCheck = jest.fn((..._args: unknown[]) => undefined)

jest.mock('./winston-transport', () => ({
  warnAboutMissingWinstonTransport: (...args: unknown[]) => mockWinstonTransportCheck(...args)
}))
jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: function (...args: unknown[]) {
    return mockNodeSdk(...args)
  }
}))
jest.mock('@opentelemetry/sdk-trace', () => ({ BatchSpanProcessor: function () {} }))
jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: function () {
    return { export: () => undefined }
  }
}))
jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: (...args: unknown[]) => mockAutoInstrumentations(...args)
}))
jest.mock('@opentelemetry/resources', () => {
  const detector = (name: string): { name: string; detect: () => { attributes: object } } => ({
    name,
    detect: () => ({ attributes: {} })
  })
  return {
    resourceFromAttributes: () => ({}),
    envDetector: detector('env'),
    hostDetector: detector('host'),
    osDetector: detector('os'),
    processDetector: detector('process'),
    serviceInstanceIdDetector: detector('serviceinstance')
  }
})

beforeEach(() => {
  mockSdkInstance.shutdown.mockResolvedValue(undefined)
})

afterEach(() => {
  clearHandle()
  clearPendingStart()
})

describe('the sampler ratio check', () => {
  const NAMES = ['OTEL_TRACES_SAMPLER', 'OTEL_TRACES_SAMPLER_ARG']

  /** Runs a start with the sampler in the process environment, which is where the SDK reads it. */
  async function startWithProcessSampler(
    processEnv: Record<string, string>,
    options: { env?: Record<string, string> } = {}
  ): Promise<jest.SpyInstance> {
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    Object.assign(process.env, processEnv)
    try {
      await startTelemetry({ serviceName: 'api', ...options })
    } finally {
      for (const name of NAMES) delete process.env[name]
    }
    return emitWarning
  }

  const samplerWarnings = (emitWarning: jest.SpyInstance): unknown[][] =>
    emitWarning.mock.calls.filter(
      ([, options]) => (options as { code?: string }).code === 'BYMAX_TELEMETRY_SAMPLER_ARG_INVALID'
    )

  it('warns once at start when the process environment gives a ratio sampler no usable ratio', async () => {
    // Scenario: the SDK would sample every trace and say so only to the diagnostic channel; the
    // start says it through the warning route, once.
    const emitWarning = await startWithProcessSampler({
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '10%'
    })
    expect(samplerWarnings(emitWarning)).toHaveLength(1)
    expect(String(samplerWarnings(emitWarning)[0]?.[0])).toContain('"10%"')
  })

  it('says nothing for a usable ratio', async () => {
    // Scenario: the same sampler with a ratio from 0 to 1 is working as configured.
    const emitWarning = await startWithProcessSampler({
      OTEL_TRACES_SAMPLER: 'parentbased_traceidratio',
      OTEL_TRACES_SAMPLER_ARG: '0.1'
    })
    expect(samplerWarnings(emitWarning)).toHaveLength(0)
  })

  it('judges the process environment, not the environment the host hands to the start', async () => {
    // Scenario: the SDK reads the sampler from the process environment whatever `env` says. A bad
    // ratio there is reported although `env` is fine, and a bad ratio in `env` alone is not,
    // because the SDK never reads it.
    const reported = await startWithProcessSampler(
      { OTEL_TRACES_SAMPLER: 'traceidratio', OTEL_TRACES_SAMPLER_ARG: '1.5' },
      { env: { OTEL_TRACES_SAMPLER: 'traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.1' } }
    )
    expect(samplerWarnings(reported)).toHaveLength(1)
    clearHandle()
    clearPendingStart()
    reported.mockClear()
    const silent = await startWithProcessSampler(
      { OTEL_TRACES_SAMPLER: 'traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.1' },
      { env: { OTEL_TRACES_SAMPLER: 'traceidratio', OTEL_TRACES_SAMPLER_ARG: '1.5' } }
    )
    expect(samplerWarnings(silent)).toHaveLength(0)
  })
})

describe('the winston transport check', () => {
  it.each([
    [
      'an exporter for logs is named in the environment',
      { OTEL_LOGS_EXPORTER: 'otlp' },
      undefined,
      true
    ],
    ['no exporter for logs is named', {}, undefined, false],
    [
      'the option turns log sending off over an exporter in the environment',
      { OTEL_LOGS_EXPORTER: 'otlp' },
      false,
      false
    ],
    ['the option turns log sending on without an exporter in the environment', {}, true, true]
  ])('is told whether log sending is on when %s', async (_name, env, sendLogs, expected) => {
    // Scenario: the check runs once per start, with the same answer the instrumentations get: the
    // option wins over the environment.
    await startTelemetry({
      serviceName: 'api',
      env,
      ...(sendLogs === undefined ? {} : { instrumentations: { sendLogs } })
    })
    expect(mockWinstonTransportCheck).toHaveBeenCalledTimes(1)
    expect(mockWinstonTransportCheck).toHaveBeenCalledWith(expected)
    // The instrumentations are configured from the same decision: their log sending is on exactly
    // when the check was told it is.
    const config = mockAutoInstrumentations.mock.calls[0]?.[0] as Record<
      string,
      { disableLogSending?: boolean }
    >
    expect(config['@opentelemetry/instrumentation-winston']?.disableLogSending).toBe(!expected)
  })
})
