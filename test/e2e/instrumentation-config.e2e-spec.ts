/**
 * @fileoverview Pins the configuration handed to the real auto-instrumentations: the safe
 * defaults and the host policy.
 * @layer e2e
 */
import { context, propagation, trace } from '@opentelemetry/api'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'

import { ignorePaths, shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'
import type { TelemetryOptions } from '@bymax-one/nest-telemetry'
import { DEFAULT_REDACTED_QUERY_PARAMS } from '@bymax-one/nest-telemetry'

import { startCollector } from './fixtures/collector'
import type { Collector } from './fixtures/collector'
import { allowRestart } from './fixtures/restart'

// The real function runs; the wrapper only records what the library passed it.
jest.mock('@opentelemetry/auto-instrumentations-node', () => {
  const actual = jest.requireActual<typeof import('@opentelemetry/auto-instrumentations-node')>(
    '@opentelemetry/auto-instrumentations-node'
  )
  return { ...actual, getNodeAutoInstrumentations: jest.fn(actual.getNodeAutoInstrumentations) }
})

const FS = '@opentelemetry/instrumentation-fs'
const HTTP = '@opentelemetry/instrumentation-http'
const IOREDIS = '@opentelemetry/instrumentation-ioredis'
const PINO = '@opentelemetry/instrumentation-pino'

let collector: Collector

beforeEach(async () => {
  // A start with no service name warns on the process; the suites that do not assert on it keep
  // the output quiet.
  jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  collector = await startCollector()
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = collector.endpoint
})

afterEach(async () => {
  await shutdownTelemetry()
  trace.disable()
  context.disable()
  propagation.disable()
  allowRestart()
  delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  await collector.close()
})

/** Starts telemetry and returns the configuration the real auto-instrumentation function received. */
async function configFor(
  options: TelemetryOptions
): Promise<Record<string, Record<string, unknown>>> {
  await startTelemetry(options)
  const calls = jest.mocked(getNodeAutoInstrumentations).mock.calls
  return calls[calls.length - 1]?.[0] as unknown as Record<string, Record<string, unknown>>
}

/** Settings that a polluted realm could plant for the instrumentations that read one when they are built. */
const PLANTED_SETTINGS = {
  captureMessageContent: true,
  dbStatementSerializer: (): string => 'planted',
  responseHook: (): void => undefined,
  lambdaHandler: 'planted.handler',
  metadataToSpanAttributes: { client: { requestMetadata: ['authorization'] } }
}

/**
 * Builds the real instrumentations while the settings above sit on the root prototype, and hands the
 * check an accessor for a built instrumentation by name.
 */
async function withPlantedSettings(
  check: (instance: (name: string) => Record<string, unknown>) => void
): Promise<void> {
  for (const [name, value] of Object.entries(PLANTED_SETTINGS)) {
    Object.defineProperty(Object.prototype, name, { value, configurable: true, writable: true })
  }
  try {
    await configFor({ env: {}, unsafe: { disableRedisArgumentRedaction: true } })
    const results = jest.mocked(getNodeAutoInstrumentations).mock.results
    const built = (results[results.length - 1]?.value ?? []) as { instrumentationName: string }[]
    check(
      (name) =>
        built.find((candidate) => candidate.instrumentationName === name) as unknown as Record<
          string,
          unknown
        >
    )
  } finally {
    for (const name of Object.keys(PLANTED_SETTINGS)) {
      delete (Object.prototype as unknown as Record<string, unknown>)[name]
    }
  }
}

describe('the configuration handed to the real auto-instrumentations', () => {
  it('applies the safe defaults', async () => {
    // Scenario: a host that passes nothing gets file-system tracing off, URL and Redis redaction
    // on, and no log forwarding.
    const config = await configFor({ env: {} })
    expect(config[FS]).toEqual({ enabled: false })
    expect(config[HTTP]).toEqual({ redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS] })
    expect(typeof config[IOREDIS]?.['dbStatementSerializer']).toBe('function')
    expect(config[PINO]).toEqual({ disableLogSending: true })
  })

  it('applies the host policy: fs, predicate, extra parameters and log forwarding', async () => {
    // Scenario: every host-policy option reaches the instrumentation it names.
    const predicate = ignorePaths([/^\/health$/])
    const config = await configFor({
      env: {},
      ignoreIncomingRequest: predicate,
      extraRedactedQueryParams: ['session'],
      instrumentations: { fs: true, sendLogs: true }
    })
    expect(config[FS]).toEqual({ enabled: true })
    expect(config[HTTP]).toEqual({
      redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS, 'session'],
      ignoreIncomingRequestHook: predicate
    })
    expect(config[PINO]).toEqual({ disableLogSending: false })
  })

  it.each([
    ['otlp', false],
    ['console', false],
    ['none', true],
    ['zipkin', true]
  ])('derives log forwarding from OTEL_LOGS_EXPORTER=%s', async (exporter, disabled) => {
    // Scenario: only an exporter that exports logs makes pino's forwarding worth turning on.
    const config = await configFor({ env: { OTEL_LOGS_EXPORTER: exporter } })
    expect(config[PINO]).toEqual({ disableLogSending: disabled })
  })

  it('lets the environment ask for metrics and the host switch log forwarding off', async () => {
    // Scenario: with exporters named, the SDK keeps its own readers and processors.
    const config = await configFor({
      env: { OTEL_METRICS_EXPORTER: 'console', OTEL_LOGS_EXPORTER: 'otlp' },
      instrumentations: { sendLogs: false }
    })
    expect(config[PINO]).toEqual({ disableLogSending: true })
  })

  it('merges host overrides without letting them undo redaction', async () => {
    // Scenario: a host configures other instrumentations, adds to the HTTP one, tries to replace
    // the redaction list and the Redis serializer, and passes an explicitly undefined entry.
    const config = await configFor({
      env: {},
      instrumentations: {
        overrides: {
          '@opentelemetry/instrumentation-pg': { enhancedDatabaseReporting: true },
          '@opentelemetry/instrumentation-redis': undefined,
          [HTTP]: { redactedQueryParams: ['mine', 'token'] },
          [IOREDIS]: { dbStatementSerializer: () => 'leaked' }
        }
      }
    })
    expect(config['@opentelemetry/instrumentation-pg']).toEqual({ enhancedDatabaseReporting: true })
    expect(config[HTTP]).toEqual({
      redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS, 'mine']
    })
    const serializer = config[IOREDIS]?.['dbStatementSerializer'] as (name: string) => string
    expect(serializer('eval')).toBe('eval')
  })

  it('refuses a redaction list that is not an array, rather than ignoring it', async () => {
    // Scenario: a malformed override value is refused before the SDK starts, so it cannot reach the merge.
    await expect(
      configFor({
        env: {},
        instrumentations: { overrides: { [HTTP]: { redactedQueryParams: 'token' as never } } }
      })
    ).rejects.toMatchObject({ option: 'instrumentations.overrides[].redactedQueryParams' })
  })

  it('merges the settings of an override that are checked, and drops the ones that are absent', async () => {
    // Scenario: the control for the case above: a hook, a list and a setting that is undefined.
    const hook = (): boolean => false
    const config = await configFor({
      env: {},
      instrumentations: {
        overrides: {
          [HTTP]: {
            ignoreIncomingRequestHook: hook,
            redactedQueryParams: ['sid'],
            gone: undefined
          } as never
        }
      }
    })
    expect(config[HTTP]).toEqual({
      ignoreIncomingRequestHook: hook,
      redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS, 'sid']
    })
  })

  it('ignores a flag that only the root prototype of the realm carries', async () => {
    // Scenario: a polluted realm cannot turn off the URL redaction or turn on the export of log records.
    for (const name of ['disableUrlRedaction', 'sendLogs']) {
      Object.defineProperty(Object.prototype, name, { value: true, configurable: true })
    }
    try {
      const config = await configFor({ env: {} })
      expect(config[HTTP]).toEqual({ redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS] })
      expect(config[PINO]).toEqual({ disableLogSending: true })
    } finally {
      for (const name of ['disableUrlRedaction', 'sendLogs']) {
        delete (Object.prototype as unknown as Record<string, unknown>)[name]
      }
    }
  })

  it.each([
    ['unsafe', { disableUrlRedaction: true, disableRedisArgumentRedaction: true }],
    [
      'instrumentations',
      { sendLogs: true, overrides: { [HTTP]: { ignoreIncomingRequestHook: () => true } } }
    ]
  ])(
    'ignores the group %s when only the root prototype of the realm carries it',
    async (name, group) => {
      // Scenario: a polluted realm cannot switch the redaction off, send log records or run a hook of its
      // own for a host that passed no such group; the configuration is the safe one and a span that
      // carries a token reaches the collector without it.
      Object.defineProperty(Object.prototype, name, { value: group, configurable: true })
      try {
        const config = await configFor({ env: {} })
        expect(config[HTTP]).toEqual({ redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS] })
        expect(config[PINO]).toEqual({ disableLogSending: true })
        expect(typeof config[IOREDIS]?.['dbStatementSerializer']).toBe('function')
        trace
          .getTracer('e2e')
          .startSpan('server', { attributes: { 'url.full': '/reset?token=S3CR3T-9f2c' } })
          .end()
        await shutdownTelemetry()
        expect(collector.bodies.join('\n')).not.toContain('S3CR3T-9f2c')
      } finally {
        delete (Object.prototype as unknown as Record<string, unknown>)[name]
      }
    }
  )

  it('does not let a variable that only the root prototype of the realm carries switch the SDK off', async () => {
    // Scenario: a polluted realm cannot disable the SDK through the environment object the host passed.
    Object.defineProperty(Object.prototype, 'OTEL_SDK_DISABLED', {
      value: 'true',
      configurable: true
    })
    try {
      const handle = await startTelemetry({ env: {} })
      expect(handle.enabled).toBe(true)
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['OTEL_SDK_DISABLED']
    }
  })

  it('builds gRPC with no metadata a planted list asks for', async () => {
    // Scenario: the gRPC instrumentation reads its metadata list from the configuration while it is built; a
    // planted list is not found, so no metadata becomes an attribute.
    await withPlantedSettings((instance) => {
      type Capture = { client: { captureRequestMetadata(span: object, metadata: object): void } }
      const grpc = instance('@opentelemetry/instrumentation-grpc')['_metadataCapture'] as Capture
      const attributes: string[] = []
      grpc.client.captureRequestMetadata(
        { setAttribute: (key: string) => attributes.push(key) },
        { get: () => ['secret'] }
      )
      expect(attributes).toEqual([])
    })
  })

  it('builds both Redis clients with no planted serializer or hook', async () => {
    // Scenario: the Redis instrumentation copies its configuration for each client, which reads the serializer
    // and the hook from it; each is an own key that is undefined.
    await withPlantedSettings((instance) => {
      for (const key of ['instrumentationV2_V3', 'instrumentationV4_V5']) {
        const client = instance('@opentelemetry/instrumentation-redis')[key] as {
          getConfig(): Record<string, unknown>
        }
        expect(client.getConfig()['dbStatementSerializer']).toBeUndefined()
        expect(client.getConfig()['responseHook']).toBeUndefined()
      }
    })
  })

  it('builds OpenAI with message capture off whatever a planted value says', async () => {
    // Scenario: the OpenAI instrumentation reads the configuration it is handed, which has no prototype, and
    // writes its own false, so a planted true is not found.
    await withPlantedSettings((instance) => {
      expect(instance('@opentelemetry/instrumentation-openai')['_config']).toMatchObject({
        captureMessageContent: false
      })
    })
  })

  it('still reads a flag that a class of the host holds, and refuses a stand-in that never ends', async () => {
    // Scenario: a class instance is the host's; a Proxy that answers itself as its prototype is refused and does not hang.
    class Options {
      get sendLogs(): boolean {
        return true
      }
    }
    const config = await configFor({ env: {}, instrumentations: new Options() })
    expect(config[PINO]).toEqual({ disableLogSending: false })
    const cycle: object = new Proxy({}, { getPrototypeOf: () => cycle })
    await expect(
      startTelemetry({ env: {}, instrumentations: cycle as never })
    ).rejects.toMatchObject({
      option: 'instrumentations'
    })
  })

  it('ends the walk of a chain that turns into a cycle after it was checked', async () => {
    // Scenario: a stand-in that answers a sound chain once and then itself does not hang the start; the flag is unset.
    let answers = 0
    const turning: object = new Proxy(
      {},
      { getPrototypeOf: () => (answers++ === 0 ? Object.prototype : turning) }
    )
    const config = await configFor({ env: {}, instrumentations: turning as never })
    expect(config[PINO]).toEqual({ disableLogSending: true })
  })

  it('honours the host Redis serializer only after the explicit opt-out', async () => {
    // Scenario: with disableRedisArgumentRedaction the override is the host's decision, and the
    // opt-out alone leaves no ioredis entry at all.
    jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const custom = (): string => 'custom'
    const withOverride = await configFor({
      env: {},
      unsafe: { disableRedisArgumentRedaction: true },
      instrumentations: { overrides: { [IOREDIS]: { dbStatementSerializer: custom } } }
    })
    expect(withOverride[IOREDIS]).toEqual({ dbStatementSerializer: custom })
    await shutdownTelemetry()
    trace.disable()
    context.disable()
    propagation.disable()
    // This case compares two SDKs started in one process, which the library refuses.
    allowRestart()
    const alone = await configFor({ env: {}, unsafe: { disableRedisArgumentRedaction: true } })
    // Own keys: a name the config does not hold answers with an empty entry.
    expect(Object.keys(alone)).not.toContain(IOREDIS)
  })
})
