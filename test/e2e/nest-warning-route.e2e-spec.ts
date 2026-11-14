/**
 * @fileoverview Pins that a bound structured logger receives the library's two runtime warnings from a real SDK.
 * @layer e2e
 */
import 'reflect-metadata'

import { createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'

import { Test } from '@nestjs/testing'
import { context, propagation, trace } from '@opentelemetry/api'

import { startTelemetry } from '@bymax-one/nest-telemetry'
import {
  TELEMETRY_EXPORT_FAILED_KEY,
  TELEMETRY_LOGGER,
  TELEMETRY_SHUTDOWN_TIMEOUT_KEY,
  TelemetryModule
} from '@bymax-one/nest-telemetry/nest'

import { reportWarning } from '../../src/sdk/warning-sink'

import { allowRestart } from './fixtures/restart'

const ENV_NAMES = [
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TIMEOUT',
  'OTEL_BSP_SCHEDULE_DELAY'
]

/** A port that was free a moment ago and has nothing listening now. */
async function closedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** The process warnings the library emitted, by code. */
function processWarnings(emitWarning: jest.SpyInstance, code: string): unknown[][] {
  return emitWarning.mock.calls.filter(
    ([, options]) => (options as { code?: string }).code === code
  )
}

afterEach(() => {
  for (const name of ENV_NAMES) delete process.env[name]
  trace.disable()
  context.disable()
  propagation.disable()
  allowRestart()
})

describe('a bound TELEMETRY_LOGGER and a collector that is down', () => {
  it('receives the export failure once, through warnStructured, with the kind and the code only', async () => {
    // Scenario: three failing batches in separate flushes. The host's logger gets one structured
    // entry, and the process warning that carries the same text is not printed as well.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const port = await closedPort()
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] =
      `http://operator:hunter2@127.0.0.1:${port}/?token=endpoint-secret`
    process.env['OTEL_EXPORTER_OTLP_TIMEOUT'] = '300'
    process.env['OTEL_BSP_SCHEDULE_DELAY'] = '50'
    await startTelemetry({ serviceName: 'api', shutdownTimeoutMs: 20_000, env: process.env })
    const logger = { errorStructured: jest.fn(), warnStructured: jest.fn() }
    const app = await Test.createTestingModule({
      imports: [TelemetryModule],
      providers: [{ provide: TELEMETRY_LOGGER, useValue: logger }]
    }).compile()
    await app.init()
    for (const name of ['first', 'second', 'third']) {
      trace.getTracer('e2e').startSpan(name).end()
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    await app.close()
    expect(logger.warnStructured).toHaveBeenCalledTimes(1)
    const [key, message, userId, metadata] = logger.warnStructured.mock.calls[0] as [
      string,
      string,
      unknown,
      Record<string, unknown>
    ]
    expect(key).toBe(TELEMETRY_EXPORT_FAILED_KEY)
    expect(userId).toBeUndefined()
    expect(metadata).toEqual({ kind: 'otlp-http traces', code: 'ECONNREFUSED' })
    expect(JSON.stringify([message, metadata])).not.toMatch(/hunter2|endpoint-secret/)
    expect(processWarnings(emitWarning, 'BYMAX_TELEMETRY_EXPORT_FAILED')).toHaveLength(0)
  })

  it('falls back to the process warning when the bound logger has no warnStructured', async () => {
    // Scenario: a logger that only has errorStructured, which is all the token required before. The
    // warning is the process warning it always was.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const port = await closedPort()
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = `http://127.0.0.1:${port}`
    process.env['OTEL_EXPORTER_OTLP_TIMEOUT'] = '300'
    process.env['OTEL_BSP_SCHEDULE_DELAY'] = '50'
    await startTelemetry({ serviceName: 'api', shutdownTimeoutMs: 20_000, env: process.env })
    const logger = { errorStructured: jest.fn() }
    const app = await Test.createTestingModule({
      imports: [TelemetryModule],
      providers: [{ provide: TELEMETRY_LOGGER, useValue: logger }]
    }).compile()
    await app.init()
    trace.getTracer('e2e').startSpan('only').end()
    await new Promise((resolve) => setTimeout(resolve, 600))
    await app.close()
    expect(processWarnings(emitWarning, 'BYMAX_TELEMETRY_EXPORT_FAILED')).toHaveLength(1)
  })
})

describe('a bound TELEMETRY_LOGGER and a collector that never answers', () => {
  it('receives the shutdown timeout through errorStructured, and no process warning is printed', async () => {
    // Scenario: the deadline passes while the module's hook is flushing. The logger gets one
    // structured error under the stable key, with the deadline in the library's own text.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const sockets: Socket[] = []
    const server: Server = createServer((socket) => {
      sockets.push(socket)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] =
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await startTelemetry({ serviceName: 'api', shutdownTimeoutMs: 400, env: process.env })
    const logger = { errorStructured: jest.fn(), warnStructured: jest.fn() }
    const app = await Test.createTestingModule({
      imports: [TelemetryModule],
      providers: [{ provide: TELEMETRY_LOGGER, useValue: logger }]
    }).compile()
    await app.init()
    trace.getTracer('e2e').startSpan('unanswered').end()
    await app.close()
    sockets.forEach((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(logger.errorStructured).toHaveBeenCalledTimes(1)
    const [key, error] = logger.errorStructured.mock.calls[0] as [string, Error]
    expect(key).toBe(TELEMETRY_SHUTDOWN_TIMEOUT_KEY)
    expect(error.message).toContain('400 ms')
    expect(processWarnings(emitWarning, 'BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT')).toHaveLength(0)
  })
})

describe('two applications in one process', () => {
  it('keeps the warning route of the application that is still running when the other closes', async () => {
    // Scenario: a test suite or a hot reload builds a second application before the first has
    // closed. The first one shutting down must not remove the logger of the second.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const first = { errorStructured: jest.fn(), warnStructured: jest.fn() }
    const second = { errorStructured: jest.fn(), warnStructured: jest.fn() }
    const firstApp = await Test.createTestingModule({
      imports: [TelemetryModule],
      providers: [{ provide: TELEMETRY_LOGGER, useValue: first }]
    }).compile()
    await firstApp.init()
    const secondApp = await Test.createTestingModule({
      imports: [TelemetryModule],
      providers: [{ provide: TELEMETRY_LOGGER, useValue: second }]
    }).compile()
    await secondApp.init()
    await firstApp.close()
    reportWarning({
      code: 'BYMAX_TELEMETRY_EXPORT_FAILED',
      text: 'Exporting spans failed.',
      fields: { kind: 'otlp-http traces', code: 'ECONNREFUSED' }
    })
    expect(second.warnStructured).toHaveBeenCalledTimes(1)
    expect(first.warnStructured).not.toHaveBeenCalled()
    expect(emitWarning).not.toHaveBeenCalled()
    await secondApp.close()
  })
})
