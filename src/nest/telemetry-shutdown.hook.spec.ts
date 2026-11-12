import 'reflect-metadata'

import { Logger } from '@nestjs/common'

import { clearHandle, createHandle, registerHandle } from '../sdk/handle'

import type { IProviderLookup } from './telemetry-shutdown.hook'
import {
  TELEMETRY_FLUSH_FAILED_KEY,
  TELEMETRY_LOGGER,
  TelemetryShutdownHook
} from './telemetry-shutdown.hook'

/** A module reference whose `get` answers with the given logger, or throws as Nest does for a missing token. */
function moduleRef(logger?: { errorStructured: jest.Mock }): IProviderLookup {
  return {
    get: (token) => {
      if (logger !== undefined && token === TELEMETRY_LOGGER) return logger
      throw new Error('Nest could not find the provider')
    }
  }
}

afterEach(() => {
  clearHandle()
})

describe('constants', () => {
  it('keeps the failure key the template already logs, so an existing alert keeps matching', () => {
    // Scenario: the key is an alert's match string, so it must not change.
    expect(TELEMETRY_FLUSH_FAILED_KEY).toBe('TRACING_FLUSH_FAILED')
  })

  it('uses a symbol for the logger token', () => {
    // Scenario: tokens are symbols, never strings, so no application token can collide.
    expect(typeof TELEMETRY_LOGGER).toBe('symbol')
  })
})

describe('TelemetryShutdownHook', () => {
  it('flushes the SDK that was started', async () => {
    // Scenario: Nest awaits this hook while closing the application, so awaiting the flush here
    // guarantees buffered spans are exported before the process exits.
    const stop = jest.fn(() => Promise.resolve())
    registerHandle(createHandle(stop))
    await new TelemetryShutdownHook(moduleRef()).onApplicationShutdown()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('does nothing when no SDK was started', async () => {
    // Scenario: telemetry is disabled, so there is nothing to drain.
    await expect(
      new TelemetryShutdownHook(moduleRef()).onApplicationShutdown()
    ).resolves.toBeUndefined()
  })

  describe('when the flush fails', () => {
    it('reports it through the structured logger under the stable key, and does not reject', async () => {
      // Scenario: the collector refuses the final export. An orchestrator reads the exit code, and
      // a collector outage is not a crashed instance, so the failure is logged and ends there.
      const logger = { errorStructured: jest.fn() }
      const failure = new Error('collector refused')
      registerHandle(createHandle(() => Promise.reject(failure)))
      await expect(
        new TelemetryShutdownHook(moduleRef(logger)).onApplicationShutdown()
      ).resolves.toBeUndefined()
      expect(logger.errorStructured).toHaveBeenCalledWith('TRACING_FLUSH_FAILED', failure)
    })

    it('wraps a value that is not an error, without stringifying it', async () => {
      // Scenario: a rejection with a plain value must not throw while it is being reported, which
      // is the one place whose job is to keep the shutdown from failing.
      const logger = { errorStructured: jest.fn() }
      registerHandle(createHandle(() => Promise.reject('plain text')))
      await new TelemetryShutdownHook(moduleRef(logger)).onApplicationShutdown()
      const [key, error] = logger.errorStructured.mock.calls[0] as [string, Error]
      expect(key).toBe('TRACING_FLUSH_FAILED')
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe('The telemetry SDK failed to shut down.')
    })

    it('falls back to the Nest logger, with the key in the message, when no structured logger is provided', async () => {
      // Scenario: a host that did not provide TELEMETRY_LOGGER still gets the failure, on the
      // logger Nest routes through app.useLogger().
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      const failure = new Error('collector refused')
      registerHandle(createHandle(() => Promise.reject(failure)))
      await new TelemetryShutdownHook(moduleRef()).onApplicationShutdown()
      expect(error).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith('TRACING_FLUSH_FAILED: collector refused', failure.stack)
      // The entry is written under the library's own context, so it can be told apart in the output.
      expect(Reflect.get(error.mock.contexts[0] as object, 'context')).toBe('Telemetry')
    })
  })
})
