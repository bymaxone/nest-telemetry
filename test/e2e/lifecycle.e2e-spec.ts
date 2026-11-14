import { context, propagation, trace } from '@opentelemetry/api'

import { shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'
import type { TelemetryHandle, TelemetryOptions } from '@bymax-one/nest-telemetry'

import { forceFlush, resourceAttributes, startCollector } from './fixtures/collector'
import type { Collector } from './fixtures/collector'
import { allowRestart } from './fixtures/restart'

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
  // A started SDK leaves its global tracer provider, context manager and propagator registered, and
  // a second start in the same process cannot replace them, so each test releases them.
  trace.disable()
  context.disable()
  propagation.disable()
  allowRestart()
  delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  delete process.env['OTEL_SDK_DISABLED']
  await collector.close()
})

/** Starts telemetry, records one span, and returns the handle. */
async function startAndRecord(options: TelemetryOptions): Promise<TelemetryHandle> {
  const handle = await startTelemetry(options)
  trace.getTracer('e2e').startSpan('work').end()
  return handle
}

describe('batch processor tuning from the standard variables', () => {
  it('exports a span without a shutdown when the schedule delay is short', async () => {
    // Scenario: OTEL_BSP_SCHEDULE_DELAY reaches the processor the library passes; at the default
    // of five seconds the span would still be queued, so its arrival proves the mapping.
    const handle = await startAndRecord({
      env: {
        OTEL_BSP_SCHEDULE_DELAY: '50',
        OTEL_BSP_MAX_QUEUE_SIZE: '2048',
        OTEL_BSP_EXPORT_TIMEOUT: '5000',
        OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '64'
      }
    })
    await expect(collector.waitForBodies(1, 3000)).resolves.toHaveLength(1)
    await handle.shutdown()
  })

  it('does not export once per span when the schedule delay is longer than a timer holds', async () => {
    // Scenario: Node clamps a timer of 3000000000 ms to 1 ms, which would export one request per
    // span. The value is ignored and the default of five seconds applies, so twenty spans over a
    // second reach the collector in no request, and the start says why.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const handle = await startTelemetry({
      serviceName: 'api',
      env: { OTEL_BSP_SCHEDULE_DELAY: '3000000000' }
    })
    for (let index = 0; index < 20; index += 1) {
      trace.getTracer('e2e').startSpan(`span-${index}`).end()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(collector.bodies).toHaveLength(0)
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('OTEL_BSP_SCHEDULE_DELAY is above 2147483647 ms'),
      { type: 'Warning', code: 'BYMAX_TELEMETRY_BSP_VALUE_IGNORED' }
    )
    await handle.shutdown()
    expect(collector.bodies.join('\n')).toContain('span-19')
  })

  it('keeps the SDK defaults when the variables are unusable', async () => {
    // Scenario: blank, non-numeric, non-positive and infinite values are ignored, so the span
    // stays queued until shutdown flushes it.
    const handle = await startAndRecord({
      env: {
        OTEL_BSP_SCHEDULE_DELAY: 'abc',
        OTEL_BSP_MAX_QUEUE_SIZE: '0',
        OTEL_BSP_EXPORT_TIMEOUT: '-1',
        OTEL_BSP_MAX_EXPORT_BATCH_SIZE: 'Infinity'
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(collector.bodies).toHaveLength(0)
    await handle.shutdown()
    expect(collector.bodies).toHaveLength(1)
  })
})

describe('service identity on the exported resource', () => {
  it('prefers OTEL_SERVICE_NAME over the host name and carries the host version', async () => {
    // Scenario: the operator's standard override beats the name the code passed.
    const handle = await startAndRecord({
      serviceName: 'from-code',
      serviceVersion: '2.3.4',
      env: { OTEL_SERVICE_NAME: 'from-env' }
    })
    await handle.shutdown()
    expect(resourceAttributes(collector.bodies[0] ?? '')).toMatchObject({
      'service.name': 'from-env',
      'service.version': '2.3.4'
    })
  })

  it('treats a blank OTEL_SERVICE_NAME as absent', async () => {
    // Scenario: an empty variable must not erase the name the code passed.
    const handle = await startAndRecord({
      serviceName: 'from-code',
      env: { OTEL_SERVICE_NAME: '' }
    })
    await handle.shutdown()
    expect(resourceAttributes(collector.bodies[0] ?? '')['service.name']).toBe('from-code')
  })

  it('uses the host name when the environment does not override it', async () => {
    // Scenario: no OTEL_SERVICE_NAME, so the name the code passed is used.
    const handle = await startAndRecord({ serviceName: 'from-code', env: {} })
    await handle.shutdown()
    expect(resourceAttributes(collector.bodies[0] ?? '')['service.name']).toBe('from-code')
  })

  it('falls back to the specification default name and ignores blank values', async () => {
    // Scenario: with no name from either source the specification default applies; a blank host
    // name and version add nothing.
    const handle = await startAndRecord({ serviceName: '', serviceVersion: '', env: {} })
    await handle.shutdown()
    const attributes = resourceAttributes(collector.bodies[0] ?? '')
    expect(attributes['service.name']).toBe('unknown_service:node')
    expect(attributes).not.toHaveProperty(['service.version'])
  })
})

describe('the service name warning', () => {
  it('warns once, with the library code, when no service name is set, and the start goes ahead', async () => {
    // Scenario: tracing must never take down a boot, so a missing name warns and starts anyway.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const handle = await startTelemetry({ env: {} })
    expect(handle.enabled).toBe(true)
    expect(emitWarning).toHaveBeenCalledTimes(1)
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('OTEL_SERVICE_NAME'), {
      type: 'Warning',
      code: 'BYMAX_TELEMETRY_SERVICE_NAME_MISSING'
    })
    await handle.shutdown()
  })

  it('stays silent when the service is named', async () => {
    // Scenario: a named service has nothing to warn about.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const handle = await startTelemetry({ serviceName: 'api', env: {} })
    expect(emitWarning).not.toHaveBeenCalled()
    await handle.shutdown()
  })
})

describe('enabling and disabling', () => {
  it.each([
    ['the host passes enabled:false', { enabled: false, env: {} }],
    ['OTEL_SDK_DISABLED is true', { env: { OTEL_SDK_DISABLED: 'true' } }],
    [
      'the host asks for enabled:true but OTEL_SDK_DISABLED is true',
      { enabled: true, env: { OTEL_SDK_DISABLED: 'TRUE' } }
    ]
  ] satisfies [string, TelemetryOptions][])('starts nothing when %s', async (_name, options) => {
    // Scenario: any one of the two off switches stops the SDK, and nothing is exported.
    const handle = await startAndRecord(options)
    await handle.shutdown()
    expect(handle.enabled).toBe(false)
    expect(collector.bodies).toHaveLength(0)
  })

  it('reads the process environment when started with no options', async () => {
    // Scenario: a bare call, as a minimal preload makes it, honours the process environment.
    process.env['OTEL_SDK_DISABLED'] = 'true'
    const handle = await startTelemetry()
    expect(handle.enabled).toBe(false)
  })

  it('delivers queued spans on a flush that does not stop the SDK', async () => {
    // Scenario: the span-end redaction sits in the processor chain, so a flush of the provider
    // reaches it and the exporter behind it, and spans arrive while the SDK keeps running.
    const handle = await startAndRecord({ env: {} })
    await forceFlush(trace.getTracerProvider())
    expect(collector.bodies).toHaveLength(1)
    await handle.shutdown()
  })

  it('stops the SDK once however often shutdown is called', async () => {
    // Scenario: a second shutdown, as a repeated signal would make, flushes nothing twice.
    const handle = await startAndRecord({ env: {} })
    await handle.shutdown()
    await handle.shutdown()
    expect(collector.bodies).toHaveLength(1)
  })

  it('leaves another registered handle alone when this one shuts down', async () => {
    // Scenario: a second copy of the library registered its own handle under the same symbol;
    // shutting this SDK down must not clear that registration.
    const key = Symbol.for('@bymax-one/nest-telemetry/handle')
    const other = { enabled: true, stopping: false, shutdown: () => Promise.resolve() }
    const store = globalThis as typeof globalThis & { [key]?: typeof other }
    const handle = await startTelemetry({ env: {} })
    store[key] = other
    await handle.shutdown()
    expect(store[key]).toBe(other)
    delete store[key]
  })

  it('returns the running handle on a second start and drains through shutdownTelemetry', async () => {
    // Scenario: a repeated start does not start a second SDK, and the application drains the
    // SDK it never constructed, which delivers the queued span.
    const first = await startAndRecord({ env: {} })
    const second = await startTelemetry({ env: {} })
    expect(second).toBe(first)
    await shutdownTelemetry()
    expect(collector.bodies).toHaveLength(1)
  })
})

describe('the process command line in the exported resource', () => {
  const ARGV_SECRET = 'ARGV-SECRET-7731'
  let added: string

  beforeEach(() => {
    added = `--api-key=${ARGV_SECRET}`
    process.argv.push(added)
  })

  afterEach(() => {
    process.argv.splice(process.argv.indexOf(added), 1)
  })

  it('exports no byte of a secret in argv, and keeps the other process facts', async () => {
    // Scenario: command-line arguments are a common carrier of secrets, so by default the whole
    // exported body is free of them while the pid, runtime and executable stay.
    const handle = await startAndRecord({ env: {} })
    await handle.shutdown()
    expect(collector.bodies.join('\n')).not.toContain(ARGV_SECRET)
    const attributes = resourceAttributes(collector.bodies[0] ?? '')
    expect(attributes).toHaveProperty(['process.pid'])
    expect(attributes).toHaveProperty(['process.runtime.name'], 'nodejs')
    expect(attributes).toHaveProperty(['process.executable.name'])
    expect(attributes).not.toHaveProperty(['process.command_args'])
  })

  it('leaves the host id and process.command out of the resource by default', async () => {
    // Scenario: host.id is the machine identifier and process.command is argv[1], which is the
    // first argument for `node -e code ARG`. Neither goes to the collector, while host.name stays.
    const handle = await startAndRecord({ env: {} })
    await handle.shutdown()
    const attributes = resourceAttributes(collector.bodies[0] ?? '')
    expect(attributes).toHaveProperty(['host.name'])
    expect(attributes).not.toHaveProperty(['host.id'])
    expect(attributes).not.toHaveProperty(['process.command'])
  })

  it('exports the host id, with a warning, when the host opts in', async () => {
    // Scenario: the explicit opt-out does something and is loud.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const handle = await startAndRecord({ env: {}, unsafe: { exportHostId: true } })
    await handle.shutdown()
    expect(resourceAttributes(collector.bodies[0] ?? '')).toHaveProperty(['host.id'])
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('Host id redaction is disabled'),
      {
        type: 'SecurityWarning',
        code: 'BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED'
      }
    )
  })

  it('exports the command line, with a warning, when the host opts in', async () => {
    // Scenario: the explicit opt-out does something and is loud.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const handle = await startAndRecord({ env: {}, unsafe: { exportProcessCommandArgs: true } })
    await handle.shutdown()
    expect(collector.bodies.join('\n')).toContain(ARGV_SECRET)
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('Process command-line redaction is disabled'),
      { type: 'SecurityWarning', code: 'BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED' }
    )
  })

  it.each([
    ['host', ['host.name', 'os.type'], ['process.pid', 'service.instance.id']],
    ['os', ['os.type'], ['host.name', 'process.pid']],
    ['process', ['process.pid'], ['host.name', 'os.type']],
    ['service', ['service.instance.id'], ['host.name', 'os.type', 'process.pid']],
    ['serviceinstance', ['service.instance.id'], ['host.name', 'process.pid']],
    ['none', [], ['host.name', 'process.pid', 'os.type', 'service.instance.id']],
    ['all', ['host.name', 'process.pid', 'os.type', 'service.instance.id'], []],
    ['bogus,process', ['process.pid'], ['host.name', 'os.type']],
    ['constructor,process', ['process.pid'], ['host.name', 'os.type']]
  ])('honours OTEL_NODE_RESOURCE_DETECTORS=%s', async (selection, present, absent) => {
    // Scenario: the operator picks the resource detectors with the standard variable, and the
    // command line stays out of whichever process detector runs.
    const handle = await startAndRecord({ env: { OTEL_NODE_RESOURCE_DETECTORS: selection } })
    await handle.shutdown()
    const attributes = resourceAttributes(collector.bodies[0] ?? '')
    for (const name of present) expect(attributes).toHaveProperty([name])
    for (const name of absent) expect(attributes).not.toHaveProperty([name])
    expect(collector.bodies.join('\n')).not.toContain(ARGV_SECRET)
  })
})

describe('overlapping shutdowns', () => {
  it('make every caller wait for the flush, and refuse a start that arrives during it', async () => {
    // Scenario: a signal handler and the application hook both shut down, and a start arrives
    // while the flush is under way. Nobody resolves before the span is delivered, the new start
    // does not receive the handle that is stopping, and once the SDK is gone it is refused.
    const first = await startAndRecord({ env: {} })
    const direct = first.shutdown()
    const viaApi = shutdownTelemetry()
    const restarted = startTelemetry({ env: {} })
    const outcome = restarted.then(
      () => 'started',
      (error: Error) => error.message
    )
    await Promise.all([direct, viaApi])
    expect(collector.bodies).toHaveLength(1)
    await expect(outcome).resolves.toContain('once per process')
  })
})

describe('a shutdown during a start', () => {
  it('waits for the start and stops the SDK it began', async () => {
    // Scenario: the application shuts down while the preload is still loading the packages; the
    // shutdown must not resolve with no handle and leave an SDK running afterwards.
    const starting = startTelemetry({ env: {} })
    const stopping = shutdownTelemetry()
    const handle = await starting
    await stopping
    expect(handle.enabled).toBe(true)
    // The SDK was stopped, so the registry is empty and a new start is refused.
    await expect(startTelemetry({ env: {} })).rejects.toThrow('once per process')
  })
})

describe('overlapping starts', () => {
  it('start one SDK and hand every caller the same handle', async () => {
    // Scenario: a preload and an application bootstrap both call start before either finishes.
    const [first, second] = await Promise.all([
      startTelemetry({ env: {} }),
      startTelemetry({ env: {} })
    ])
    expect(second).toBe(first)
    await shutdownTelemetry()
  })
})

describe('a later call while the SDK is running', () => {
  it('keeps the first start in force, and says the options of the later call were ignored', async () => {
    // Scenario: an application passes its policy after the preload started the SDK. The exported
    // resource still carries the first start's name and still leaves the command line out, and the
    // host is told so, instead of finding out from a span.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const first = await startAndRecord({ serviceName: 'first', env: {} })
    const second = await startTelemetry({
      serviceName: 'second',
      unsafe: { exportProcessCommandArgs: true },
      env: {}
    })
    expect(second).toBe(first)
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('the options of this call were ignored'),
      {
        type: 'Warning',
        code: 'BYMAX_TELEMETRY_OPTIONS_IGNORED'
      }
    )
    await shutdownTelemetry()
    const attributes = resourceAttributes(collector.bodies[0] ?? '')
    expect(attributes['service.name']).toBe('first')
    expect(attributes).not.toHaveProperty(['process.command_args'])
  })

  it('stays silent when the later call passes no option', async () => {
    // Scenario: a bare repeated start, as a library makes to be sure telemetry is on, has nothing
    // to ignore, so it returns the running handle and says nothing.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const first = await startTelemetry({ serviceName: 'api', env: {} })
    emitWarning.mockClear()
    const second = await startTelemetry()
    expect(second).toBe(first)
    expect(emitWarning).not.toHaveBeenCalled()
  })

  it('says enabled:false does not stop the SDK, which keeps exporting', async () => {
    // Scenario: a host that asks for telemetry off after it started gets a disabled handle; the
    // running SDK is untouched, so a span recorded afterwards is still delivered.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    await startTelemetry({ serviceName: 'api', env: {} })
    const handle = await startTelemetry({ enabled: false, env: {} })
    expect(handle.enabled).toBe(false)
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('does not stop the running SDK'),
      {
        type: 'Warning',
        code: 'BYMAX_TELEMETRY_OPTIONS_IGNORED'
      }
    )
    trace.getTracer('e2e').startSpan('after-disable').end()
    await shutdownTelemetry()
    expect(collector.bodies.join('')).toContain('after-disable')
  })
})
