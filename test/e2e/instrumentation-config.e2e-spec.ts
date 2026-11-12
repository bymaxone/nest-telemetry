import { context, propagation, trace } from '@opentelemetry/api'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'

import { ignorePaths, shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'
import type { TelemetryOptions } from '@bymax-one/nest-telemetry'
import { DEFAULT_REDACTED_QUERY_PARAMS } from '@bymax-one/nest-telemetry'

import { startCollector } from './fixtures/collector'
import type { Collector } from './fixtures/collector'

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

  it('ignores a redaction list that is not an array', async () => {
    // Scenario: a malformed override value cannot remove the library's names.
    const config = await configFor({
      env: {},
      instrumentations: { overrides: { [HTTP]: { redactedQueryParams: 'token' as never } } }
    })
    expect(config[HTTP]).toEqual({ redactedQueryParams: [...DEFAULT_REDACTED_QUERY_PARAMS] })
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
    const alone = await configFor({ env: {}, unsafe: { disableRedisArgumentRedaction: true } })
    expect(alone).not.toHaveProperty([IOREDIS])
  })
})
