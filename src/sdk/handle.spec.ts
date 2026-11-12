import { clearHandle, currentHandle, registerHandle, shutdownTelemetry } from './handle'
import type { TelemetryHandle } from './types'

/** A handle double whose `shutdown` is a spy. */
function fakeHandle(): TelemetryHandle & { shutdown: jest.Mock<Promise<void>, []> } {
  return { enabled: true, shutdown: jest.fn<Promise<void>, []>(() => Promise.resolve()) }
}

afterEach(() => {
  clearHandle()
})

describe('registerHandle and currentHandle', () => {
  it('returns undefined when nothing is registered', () => {
    // Scenario: telemetry never started, so there is nothing to drain.
    expect(currentHandle()).toBeUndefined()
  })

  it('returns the registered handle', () => {
    // Scenario: the preload registers, the application reads it back.
    const handle = fakeHandle()
    registerHandle(handle)
    expect(currentHandle()).toBe(handle)
  })

  it('shares the handle through the global symbol registry', () => {
    // Scenario: the preload and the application are separate module graphs that share only
    // globalThis; the handle lives under a registry symbol, not a string key.
    const handle = fakeHandle()
    registerHandle(handle)
    const slot = (globalThis as Record<symbol, unknown>)[
      Symbol.for('@bymax-one/nest-telemetry/handle')
    ]
    expect(slot).toBe(handle)
  })

  it('forgets the handle once cleared', () => {
    // Scenario: after shutdown the slot is empty again.
    registerHandle(fakeHandle())
    clearHandle()
    expect(currentHandle()).toBeUndefined()
  })
})

describe('shutdownTelemetry', () => {
  it('resolves without effect when nothing is registered', async () => {
    // Scenario: tracing disabled, so the application's shutdown hook is a no-op.
    await expect(shutdownTelemetry()).resolves.toBeUndefined()
  })

  it('shuts the registered handle down', async () => {
    // Scenario: the application drains the SDK the preload started.
    const handle = fakeHandle()
    registerHandle(handle)
    await shutdownTelemetry()
    expect(handle.shutdown).toHaveBeenCalledTimes(1)
  })

  it('propagates a failed shutdown to the caller', async () => {
    // Scenario: the caller (the Nest hook) decides what a refused flush means; the library
    // does not swallow it.
    const handle = fakeHandle()
    handle.shutdown.mockRejectedValueOnce(new Error('collector refused'))
    registerHandle(handle)
    await expect(shutdownTelemetry()).rejects.toThrow('collector refused')
  })
})
