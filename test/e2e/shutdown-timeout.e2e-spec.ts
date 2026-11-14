/**
 * @fileoverview Pins that a collector which accepts a connection and never answers cannot hold shutdown past its deadline.
 * @layer e2e
 */
import { createServer } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'

import { context, propagation, trace } from '@opentelemetry/api'

import { shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'

import { allowRestart } from './fixtures/restart'

let server: Server
let sockets: Socket[]

beforeEach(async () => {
  sockets = []
  server = createServer((socket) => {
    sockets.push(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] =
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  trace.disable()
  context.disable()
  propagation.disable()
  allowRestart()
  delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  sockets.forEach((socket) => socket.destroy())
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('shutdownTimeoutMs against a collector that never answers', () => {
  it('resolves at the deadline with a warning instead of waiting for the exporter', async () => {
    // Scenario: the exporter's own timeout is ten seconds, so without the library's deadline this
    // shutdown would hold the process for that long. With a 500 ms deadline it ends far below the ten
    // seconds. The lower bound allows a few milliseconds for the clock, and the upper bound is a
    // margin a loaded machine does not reach. That the option, and not the default of five seconds,
    // reached the handle is read from the warning, which names the deadline.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    await startTelemetry({ serviceName: 'api', shutdownTimeoutMs: 500, env: process.env })
    trace.getTracer('e2e').startSpan('never-acknowledged').end()
    const started = Date.now()
    await shutdownTelemetry()
    const elapsed = Date.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(500 - 5)
    expect(elapsed).toBeLessThan(9000)
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('did not finish within 500 ms'),
      {
        type: 'Warning',
        code: 'BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT'
      }
    )
  })
})
