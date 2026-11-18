/**
 * @fileoverview Tests the shutdown hook: its log keys and logger token, the flush on close, and
 * how a failed flush is reported.
 * @layer nest
 */
import 'reflect-metadata'

import { Logger } from '@nestjs/common'

import { clearHandle, createHandle, registerHandle } from '../sdk/handle'
import { clearWarningSink, reportWarning } from '../sdk/warning-sink'

import type { IProviderLookup } from './telemetry-shutdown.hook'
import {
  TELEMETRY_EXPORT_FAILED_KEY,
  TELEMETRY_FLUSH_FAILED_KEY,
  TELEMETRY_LOGGER,
  TELEMETRY_SHUTDOWN_TIMEOUT_KEY,
  TelemetryShutdownHook
} from './telemetry-shutdown.hook'

/** A module reference whose `get` answers with the given logger, or throws as Nest does for a missing token. */
function moduleRef(logger?: object): IProviderLookup {
  return {
    get: (token) => {
      if (logger !== undefined && token === TELEMETRY_LOGGER) return logger
      throw new Error('Nest could not find the provider')
    }
  }
}

afterEach(() => {
  clearHandle()
  clearWarningSink()
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

    it.each([
      ['has no errorStructured method', {}],
      ['has an errorStructured that is not a function', { errorStructured: 'not callable' }]
    ])('falls back to the Nest logger when the provided logger %s', async (_what, provided) => {
      // Scenario: the host binds the public TELEMETRY_LOGGER token to the wrong value. Reporting must
      // still end in a resolved shutdown, with the failure on the Nest logger.
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      registerHandle(createHandle(() => Promise.reject(new Error('collector refused'))))
      const ref: IProviderLookup = { get: () => provided }
      await expect(new TelemetryShutdownHook(ref).onApplicationShutdown()).resolves.toBeUndefined()
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('TRACING_FLUSH_FAILED: the telemetry flush failed')
      )
    })

    it('falls back to the Nest logger when the structured logger throws', async () => {
      // Scenario: the application's logger fails while writing the entry.
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      const errorStructured = jest.fn(() => {
        throw new Error('logger failed')
      })
      registerHandle(createHandle(() => Promise.reject(new Error('collector refused'))))
      await expect(
        new TelemetryShutdownHook(moduleRef({ errorStructured })).onApplicationShutdown()
      ).resolves.toBeUndefined()
      expect(errorStructured).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('TRACING_FLUSH_FAILED: the telemetry flush failed')
      )
    })

    it('still resolves when the Nest logger throws too', async () => {
      // Scenario: nothing is left to report through, and the shutdown still must not fail.
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
        throw new Error('nest logger failed')
      })
      registerHandle(createHandle(() => Promise.reject(new Error('collector refused'))))
      await expect(
        new TelemetryShutdownHook(moduleRef()).onApplicationShutdown()
      ).resolves.toBeUndefined()
    })

    it('falls back to the Nest logger, with the key in the message, when no structured logger is provided', async () => {
      // Scenario: a host that did not provide TELEMETRY_LOGGER still gets the failure, on the
      // logger Nest routes through app.useLogger(), with the key and a short code and nothing the
      // exporter said.
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      const failure = Object.assign(new Error('collector refused'), { code: 'ECONNREFUSED' })
      registerHandle(createHandle(() => Promise.reject(failure)))
      await new TelemetryShutdownHook(moduleRef()).onApplicationShutdown()
      expect(error).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(
          /^TRACING_FLUSH_FAILED: the telemetry flush failed \(code ECONNREFUSED\)\./
        )
      )
      // The entry is written under the library's own context, so it can be told apart in the output.
      expect(Reflect.get(error.mock.contexts[0] as object, 'context')).toBe('Telemetry')
    })

    it.each([
      ['ECONNREFUSED', 'ECONNREFUSED'],
      ['a code of one character', 'E'],
      ['a code of 40 characters', 'A'.repeat(40)],
      ['a numeric code', 503],
      ['an empty code', ''],
      ['a code of 41 characters', 'A'.repeat(41)],
      ['a lower-case code', 'econnrefused'],
      ['a code with a trailing newline', 'SAFE\n'],
      ['a code with a trailing carriage return and newline', 'SAFE\r\n'],
      [
        'a code object whose toString throws',
        {
          toString: () => {
            throw new Error('boom')
          }
        }
      ],
      ['a code object without a prototype', Object.create(null)]
    ])('names the code in the Nest logger entry for %s, or UNKNOWN', async (_what, code) => {
      // Scenario: only an upper-case token of 1 to 40 characters, a string or a number, reaches
      // the entry; anything else, however odd, becomes UNKNOWN and the entry is still written.
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
      const failure = Object.assign(new Error('x'), { code })
      registerHandle(createHandle(() => Promise.reject(failure)))
      await new TelemetryShutdownHook(moduleRef()).onApplicationShutdown()
      const accepted = typeof code === 'string' || typeof code === 'number'
      const token = accepted && /^[A-Z0-9_]{1,40}$/.test(String(code)) ? String(code) : 'UNKNOWN'
      expect(error).toHaveBeenCalledTimes(1)
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`(code ${token}).`))
      expect(String(error.mock.calls[0]?.[0])).not.toContain('\n')
    })

    it.each([
      [
        'a string code that is not a plain token',
        'http://user:hunter2@collector.example/v1/traces'
      ],
      ['no code', undefined]
    ])(
      'writes neither the message nor the stack of the failure to the Nest logger, with %s',
      async (_what, code) => {
        // Scenario: an exporter's error can carry the endpoint it called, credentials included, in
        // its message and in the first line of its stack; the fallback entry must hold library
        // text only, and the code falls back to UNKNOWN unless it is a plain token.
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
        const failure = new Error('POST http://user:hunter2@collector.example/v1/traces refused')
        if (code !== undefined) Object.assign(failure, { code })
        registerHandle(createHandle(() => Promise.reject(failure)))
        await new TelemetryShutdownHook(moduleRef()).onApplicationShutdown()
        const written = JSON.stringify(error.mock.calls)
        expect(written).not.toContain('hunter2')
        expect(written).not.toContain('collector.example')
        expect(written).toContain('(code UNKNOWN)')
      }
    )
  })
})

describe('the warning route', () => {
  const EXPORT_WARNING = {
    code: 'BYMAX_TELEMETRY_EXPORT_FAILED',
    text: 'Exporting spans failed (otlp-http traces, code ECONNREFUSED), so the batch was dropped.',
    fields: { kind: 'otlp-http traces', code: 'ECONNREFUSED' }
  }
  let emitWarning: jest.SpyInstance

  beforeEach(() => {
    emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  })

  it('keeps stable keys in the family of the flush key', () => {
    // Scenario: the keys are an alert's match strings, so they must not change.
    expect(TELEMETRY_SHUTDOWN_TIMEOUT_KEY).toBe('TRACING_SHUTDOWN_TIMEOUT')
    expect(TELEMETRY_EXPORT_FAILED_KEY).toBe('TRACING_EXPORT_FAILED')
  })

  it('reports a failed export through warnStructured with the kind and the code only', () => {
    // Scenario: the host bound a structured logger, so a down collector is one alertable entry.
    const logger = { warnStructured: jest.fn() }
    new TelemetryShutdownHook(moduleRef(logger)).onModuleInit()
    reportWarning(EXPORT_WARNING)
    expect(logger.warnStructured).toHaveBeenCalledTimes(1)
    expect(logger.warnStructured).toHaveBeenCalledWith(
      TELEMETRY_EXPORT_FAILED_KEY,
      EXPORT_WARNING.text,
      undefined,
      { kind: 'otlp-http traces', code: 'ECONNREFUSED' }
    )
    expect(emitWarning).not.toHaveBeenCalled()
  })

  it('reports the shutdown timeout through errorStructured, like a failed flush', async () => {
    // Scenario: the deadline passes while the hook is flushing. The sink is still registered then, so
    // the timeout reaches the logger as a structured error and not as a process warning.
    jest.useFakeTimers()
    try {
      const logger = { errorStructured: jest.fn() }
      registerHandle(createHandle(() => new Promise<void>(() => undefined), 400))
      const hook = new TelemetryShutdownHook(moduleRef(logger))
      hook.onModuleInit()
      const done = hook.onApplicationShutdown()
      await jest.advanceTimersByTimeAsync(400)
      await done
      expect(logger.errorStructured).toHaveBeenCalledTimes(1)
      const [key, error] = logger.errorStructured.mock.calls[0] as [string, Error]
      expect(key).toBe(TELEMETRY_SHUTDOWN_TIMEOUT_KEY)
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toContain('400 ms')
      expect(emitWarning).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it('registers nothing when no logger is bound, so the warning is a process warning', () => {
    // Scenario: a host without TELEMETRY_LOGGER gets the process warning.
    new TelemetryShutdownHook(moduleRef()).onModuleInit()
    expect(
      Reflect.get(globalThis, Symbol.for('@bymax-one/nest-telemetry/warning-sink'))
    ).toBeUndefined()
    reportWarning(EXPORT_WARNING)
    expect(emitWarning).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['has no warnStructured', { errorStructured: jest.fn() }],
    ['has a warnStructured that is not a function', { warnStructured: 'not callable' }]
  ])('falls back to the process warning when the logger %s', (_what, logger) => {
    // Scenario: the bound logger cannot take this warning.
    new TelemetryShutdownHook(moduleRef(logger)).onModuleInit()
    reportWarning(EXPORT_WARNING)
    expect(emitWarning).toHaveBeenCalledTimes(1)
  })

  it('falls back to the process warning when the logger throws', () => {
    // Scenario: the application's logger fails while writing the entry.
    const logger = {
      warnStructured: jest.fn(() => {
        throw new Error('logger failed')
      })
    }
    new TelemetryShutdownHook(moduleRef(logger)).onModuleInit()
    expect(() => reportWarning(EXPORT_WARNING)).not.toThrow()
    expect(emitWarning).toHaveBeenCalledTimes(1)
  })

  it('leaves a warning with no route to the process warning', () => {
    // Scenario: a code the hook has no key for, such as a later warning, is never swallowed.
    const logger = { warnStructured: jest.fn(), errorStructured: jest.fn() }
    new TelemetryShutdownHook(moduleRef(logger)).onModuleInit()
    reportWarning({ code: 'BYMAX_TELEMETRY_SOMETHING_ELSE', text: 'other' })
    expect(logger.warnStructured).not.toHaveBeenCalled()
    expect(logger.errorStructured).not.toHaveBeenCalled()
    expect(emitWarning).toHaveBeenCalledTimes(1)
  })

  it('releases its sink once the flush has settled', async () => {
    // Scenario: after shutdown the logger is going away, so a later warning is a process warning.
    const logger = { warnStructured: jest.fn() }
    registerHandle(createHandle(() => Promise.resolve()))
    const hook = new TelemetryShutdownHook(moduleRef(logger))
    hook.onModuleInit()
    await hook.onApplicationShutdown()
    reportWarning(EXPORT_WARNING)
    expect(logger.warnStructured).not.toHaveBeenCalled()
    expect(emitWarning).toHaveBeenCalledTimes(1)
  })

  it('does not release the sink of another module instance', async () => {
    // Scenario: two applications in one process, as in a test suite or a hot reload. The first one
    // shutting down must leave the second one's logger in place.
    const first = { warnStructured: jest.fn() }
    const second = { warnStructured: jest.fn() }
    registerHandle(createHandle(() => Promise.resolve()))
    const firstHook = new TelemetryShutdownHook(moduleRef(first))
    const secondHook = new TelemetryShutdownHook(moduleRef(second))
    firstHook.onModuleInit()
    secondHook.onModuleInit()
    await firstHook.onApplicationShutdown()
    reportWarning(EXPORT_WARNING)
    expect(second.warnStructured).toHaveBeenCalledTimes(1)
    expect(first.warnStructured).not.toHaveBeenCalled()
  })
})
