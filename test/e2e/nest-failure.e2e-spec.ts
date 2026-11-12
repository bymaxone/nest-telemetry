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

  it('falls back to the Nest logger when none is provided, and wraps a value that is not an error', async () => {
    // Scenario: no TELEMETRY_LOGGER anywhere in the application, and the rejection is a string.
    mockShutdown.mockRejectedValueOnce('plain text')
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const app = await Test.createTestingModule({ imports: [TelemetryModule] }).compile()
    await app.init()
    await expect(app.close()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith(
      'TRACING_FLUSH_FAILED: The telemetry SDK failed to shut down.',
      expect.any(String)
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
      'TRACING_FLUSH_FAILED: collector refused',
      expect.any(String)
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
