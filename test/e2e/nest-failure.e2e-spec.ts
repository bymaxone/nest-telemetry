/**
 * @fileoverview Pins how TelemetryModule reports a failed flush in a real Nest application,
 * through a provided logger and through the Nest logger.
 * @layer e2e
 */
import 'reflect-metadata'

import { Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'

import { TELEMETRY_LOGGER, TelemetryModule } from '@bymax-one/nest-telemetry/nest'

// The flush fails, as when the collector refuses the final export.
const mockShutdown = jest.fn<Promise<void>, []>()
jest.mock('../../src/sdk/handle', () => ({
  ...jest.requireActual<typeof import('../../src/sdk/handle')>('../../src/sdk/handle'),
  shutdownTelemetry: () => mockShutdown()
}))

describe('TelemetryModule when the flush fails, in a real Nest application', () => {
  it('reports through a structured logger the application provides, and closes cleanly', async () => {
    // Scenario: the application binds TELEMETRY_LOGGER to its own structured logger; the failure
    // arrives there under the stable key, and close() does not reject.
    const failure = new Error('collector refused')
    mockShutdown.mockRejectedValueOnce(failure)
    const errorStructured = jest.fn()
    const app = await Test.createTestingModule({
      imports: [TelemetryModule],
      providers: [{ provide: TELEMETRY_LOGGER, useValue: { errorStructured } }]
    }).compile()
    await app.init()
    await expect(app.close()).resolves.toBeUndefined()
    expect(errorStructured).toHaveBeenCalledWith('TRACING_FLUSH_FAILED', failure)
  })

  it('names a numeric code of the failure in the Nest logger entry', async () => {
    // Scenario: a collector that answers with a status; the entry carries the number as the code.
    mockShutdown.mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), { code: 502 }))
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const app = await Test.createTestingModule({ imports: [TelemetryModule] }).compile()
    await app.init()
    await expect(app.close()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('(code 502)'))
  })

  it('writes a code that is not a plain token as UNKNOWN, never as text', async () => {
    // Scenario: a code that is a URL with credentials is free text, not a code, and is not written.
    mockShutdown.mockRejectedValueOnce(
      Object.assign(new Error('refused'), { code: 'http://user:hunter2@collector.example/' })
    )
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const app = await Test.createTestingModule({ imports: [TelemetryModule] }).compile()
    await app.init()
    await expect(app.close()).resolves.toBeUndefined()
    const written = JSON.stringify(error.mock.calls)
    expect(written).toContain('(code UNKNOWN)')
    expect(written).not.toContain('hunter2')
  })

  it('writes neither the message nor the code of a failure whose code cannot be read', async () => {
    // Scenario: the failure of an exporter quotes its endpoint, and its code is a getter that throws;
    // the entry is still written, with library text and the code UNKNOWN.
    const failure = Object.defineProperty(
      new Error('POST http://user:hunter2@collector.example/'),
      'code',
      {
        get: () => {
          throw new Error('boom')
        }
      }
    )
    mockShutdown.mockRejectedValueOnce(failure)
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const app = await Test.createTestingModule({ imports: [TelemetryModule] }).compile()
    await app.init()
    await expect(app.close()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
    const written = JSON.stringify(error.mock.calls)
    expect(written).toContain('(code UNKNOWN)')
    expect(written).not.toContain('hunter2')
  })

  it('falls back to the Nest logger when none is provided, and wraps a value that is not an error', async () => {
    // Scenario: no TELEMETRY_LOGGER anywhere in the application, and the rejection is a string.
    mockShutdown.mockRejectedValueOnce('plain text')
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const app = await Test.createTestingModule({ imports: [TelemetryModule] }).compile()
    await app.init()
    await expect(app.close()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('TRACING_FLUSH_FAILED: the telemetry flush failed (code UNKNOWN)')
    )
  })

  it.each([
    ['a value without errorStructured', { provide: TELEMETRY_LOGGER, useValue: {} }],
    [
      'a logger that throws',
      {
        provide: TELEMETRY_LOGGER,
        useValue: {
          errorStructured: () => {
            throw new Error('logger failed')
          }
        }
      }
    ]
  ])('closes cleanly and falls back to the Nest logger for %s', async (_what, provider) => {
    // Scenario: the application binds the public logger token to something that cannot report.
    mockShutdown.mockRejectedValueOnce(new Error('collector refused'))
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const app = await Test.createTestingModule({
      imports: [TelemetryModule],
      providers: [provider]
    }).compile()
    await app.init()
    await expect(app.close()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('TRACING_FLUSH_FAILED: the telemetry flush failed (code UNKNOWN)')
    )
  })

  it('closes cleanly even when the Nest logger throws', async () => {
    // Scenario: every way of reporting has failed, and the application still shuts down.
    mockShutdown.mockRejectedValueOnce(new Error('collector refused'))
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
      throw new Error('nest logger failed')
    })
    const app = await Test.createTestingModule({ imports: [TelemetryModule] }).compile()
    await app.init()
    await expect(app.close()).resolves.toBeUndefined()
  })
})
