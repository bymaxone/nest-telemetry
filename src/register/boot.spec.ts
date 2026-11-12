import { register } from 'node:module'

import { ESM_HOOK_SPECIFIER, bootFromEnvironment } from './boot'
import type { BootDependencies } from './boot'
import type { TelemetryHandle, TelemetryOptions } from '../sdk/types'

jest.mock('node:module', () => ({ register: jest.fn() }))

const PARENT = 'file:///app/node_modules/@bymax-one/nest-telemetry/dist/register/index.mjs'

/** A handle double. */
function handle(enabled: boolean): TelemetryHandle {
  return { enabled, shutdown: jest.fn(() => Promise.resolve()) }
}

/** Dependencies whose calls the test can read. */
function dependencies(started: TelemetryHandle): {
  deps: BootDependencies
  registerHook: jest.Mock<void, [string, string]>
  start: jest.Mock<Promise<TelemetryHandle>, [TelemetryOptions]>
} {
  const registerHook = jest.fn<void, [string, string]>()
  const start = jest.fn<Promise<TelemetryHandle>, [TelemetryOptions]>(() =>
    Promise.resolve(started)
  )
  return { deps: { registerHook, start }, registerHook, start }
}

describe('ESM_HOOK_SPECIFIER', () => {
  it('names the loader hook of the OpenTelemetry instrumentation package', () => {
    // Scenario: this exact specifier is what lets native ES modules be instrumented, so it is
    // pinned; a typo would silently leave an ESM application without spans.
    expect(ESM_HOOK_SPECIFIER).toBe('@opentelemetry/instrumentation/hook.mjs')
  })
})

describe('bootFromEnvironment defaults', () => {
  it('registers the hook through module.register when none is injected', async () => {
    // Scenario: the preload file passes only the parent URL, so the real loader registration runs.
    const { start } = dependencies(handle(true))
    await bootFromEnvironment(PARENT, { env: {}, start })
    expect(register).toHaveBeenCalledWith(ESM_HOOK_SPECIFIER, PARENT)
  })

  it('starts through startTelemetry when none is injected, and a disabled one loads nothing', async () => {
    // Scenario: with OTEL_SDK_DISABLED the real start returns its disabled handle without loading
    // any OpenTelemetry package.
    const result = await bootFromEnvironment(PARENT, { env: { OTEL_SDK_DISABLED: 'true' } })
    expect(result.enabled).toBe(false)
  })
})

describe('bootFromEnvironment called as the preload calls it', () => {
  it('reads the process environment when it is given the parent URL alone', async () => {
    // Scenario: the preload file is two lines and passes nothing else, so every default applies.
    const previous = process.env['OTEL_SDK_DISABLED']
    process.env['OTEL_SDK_DISABLED'] = 'true'
    try {
      expect((await bootFromEnvironment(PARENT)).enabled).toBe(false)
    } finally {
      if (previous === undefined) delete process.env['OTEL_SDK_DISABLED']
      else process.env['OTEL_SDK_DISABLED'] = previous
    }
  })
})

describe('bootFromEnvironment', () => {
  it('registers the loader hook from the preload, then starts the SDK, in that order', async () => {
    // Scenario: the hook must be in place before the SDK builds its instrumentations and before
    // the application imports anything, so it comes first.
    const order: string[] = []
    const started = handle(true)
    const result = await bootFromEnvironment(PARENT, {
      env: {},
      registerHook: () => {
        order.push('hook')
      },
      start: () => {
        order.push('start')
        return Promise.resolve(started)
      }
    })
    expect(order).toEqual(['hook', 'start'])
    expect(result).toBe(started)
  })

  it('resolves the hook from the preload file', async () => {
    // Scenario: the peer is resolved beside the package, not from wherever the application is.
    const { deps, registerHook } = dependencies(handle(true))
    await bootFromEnvironment(PARENT, { ...deps, env: {} })
    expect(registerHook).toHaveBeenCalledWith(ESM_HOOK_SPECIFIER, PARENT)
  })

  it('passes the environment on to the start', async () => {
    // Scenario: the preload reads only what it is given, and the start sees the same variables.
    const { deps, start } = dependencies(handle(true))
    await bootFromEnvironment(PARENT, { ...deps, env: { OTEL_SERVICE_NAME: 'api' } })
    expect(start).toHaveBeenCalledWith({ env: { OTEL_SERVICE_NAME: 'api' } })
  })

  it('starts with no options when no environment is given, reading the process environment', async () => {
    // Scenario: the preload file calls it with the parent URL alone.
    const { registerHook, start } = dependencies(handle(true))
    await bootFromEnvironment(PARENT, { registerHook, start })
    expect(start).toHaveBeenCalledWith({})
  })

  it('registers no hook and loads nothing when OTEL_SDK_DISABLED is true', async () => {
    // Scenario: a disabled boot costs nothing, so the loader hook is not even registered; the
    // start still runs and returns its disabled handle.
    const disabled = handle(false)
    const { deps, registerHook, start } = dependencies(disabled)
    const result = await bootFromEnvironment(PARENT, {
      ...deps,
      env: { OTEL_SDK_DISABLED: 'true' }
    })
    expect(registerHook).not.toHaveBeenCalled()
    expect(start).toHaveBeenCalledTimes(1)
    expect(result).toBe(disabled)
  })

  it('warns, and still starts, when the loader hook cannot be registered', async () => {
    // Scenario: the instrumentation peer is not installed. CommonJS applications are instrumented
    // without the hook, so the boot goes on, and the host is told what native ESM loses.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const started = handle(true)
    const { deps, start } = dependencies(started)
    const result = await bootFromEnvironment(PARENT, {
      ...deps,
      env: {},
      registerHook: () => {
        throw new Error('Cannot find package')
      }
    })
    expect(result).toBe(started)
    expect(start).toHaveBeenCalledTimes(1)
    expect(emitWarning).toHaveBeenCalledTimes(1)
    expect(emitWarning).toHaveBeenCalledWith(
      'The OpenTelemetry loader hook could not be registered (Error: Cannot find package), so native ES modules are not instrumented. Install @opentelemetry/instrumentation to instrument them; CommonJS code is unaffected.',
      { type: 'Warning', code: 'BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE' }
    )
  })

  it('reports a thrown value that is not an error by its text', async () => {
    // Scenario: a loader that throws a string still produces a readable warning.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const { deps } = dependencies(handle(true))
    await bootFromEnvironment(PARENT, {
      ...deps,
      env: {},
      registerHook: () => {
        throw 'plain text'
      }
    })
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('(plain text)'),
      expect.anything()
    )
  })

  describe('when the SDK cannot be started', () => {
    it.each([
      ['rejects', () => Promise.reject(new Error('exporter initialization failed'))],
      [
        'throws before returning a promise',
        (): Promise<TelemetryHandle> => {
          throw new Error('constructor failed')
        }
      ]
    ])('warns, and returns a disabled handle, when the start %s', async (_how, start) => {
      // Scenario: a package is missing or the SDK constructor throws. The preload is a top-level
      // await, so letting the failure out would stop Node before the application loads; tracing
      // must never take down a boot, so the host is told and the application goes on.
      const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const { registerHook } = dependencies(handle(true))
      const result = await bootFromEnvironment(PARENT, { env: {}, registerHook, start })
      expect(result.enabled).toBe(false)
      await expect(result.shutdown()).resolves.toBeUndefined()
      expect(emitWarning).toHaveBeenCalledTimes(1)
      expect(emitWarning).toHaveBeenCalledWith(
        expect.stringMatching(
          /^Telemetry could not be started \(Error: (exporter initialization failed|constructor failed)\), so the application continues without it\.$/
        ),
        { type: 'Warning', code: 'BYMAX_TELEMETRY_START_FAILED' }
      )
    })

    it('installs no exit listener for a start that failed', async () => {
      // Scenario: there is no SDK to flush.
      jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const once = jest.spyOn(process, 'once').mockImplementation(() => process)
      const { registerHook } = dependencies(handle(true))
      await bootFromEnvironment(PARENT, {
        env: {},
        registerHook,
        start: () => Promise.reject(new Error('failed'))
      })
      expect(once).not.toHaveBeenCalled()
    })
  })

  describe('flushing on exit', () => {
    it('flushes on a natural exit when the SDK started', async () => {
      // Scenario: a process that ends by running out of work must still deliver its last spans;
      // the preload flushes on `beforeExit`. Signals are left to the application.
      const once = jest.spyOn(process, 'once').mockImplementation(() => process)
      const started = handle(true)
      const { deps } = dependencies(started)
      await bootFromEnvironment(PARENT, { ...deps, env: {} })
      expect(once).toHaveBeenCalledWith('beforeExit', expect.any(Function))
      const listener = once.mock.calls.find(([name]) => name === 'beforeExit')?.[1] as () => void
      listener()
      await new Promise((resolve) => setImmediate(resolve))
      expect(started.shutdown).toHaveBeenCalledTimes(1)
    })

    it('does not install an exit listener when the SDK did not start', async () => {
      // Scenario: a disabled boot leaves no trace on the process.
      const once = jest.spyOn(process, 'once').mockImplementation(() => process)
      const { deps } = dependencies(handle(false))
      await bootFromEnvironment(PARENT, { ...deps, env: {} })
      expect(once).not.toHaveBeenCalled()
    })
  })
})
