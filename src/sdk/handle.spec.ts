import {
  clearHandle,
  clearPendingStart,
  createHandle,
  currentHandle,
  hasStopped,
  pendingStart,
  registerHandle,
  setPendingStart,
  shutdownTelemetry
} from './handle'
import type { RunningHandle } from './handle'

/** A stop function whose completion the test controls. */
function deferredStop(): {
  stop: jest.Mock<Promise<void>, []>
  finish(): void
  fail(error: Error): void
} {
  let finish = (): void => undefined
  let fail = (_error: Error): void => undefined
  const stop = jest.fn<Promise<void>, []>(
    () =>
      new Promise<void>((resolve, reject) => {
        finish = resolve
        fail = reject
      })
  )
  return { stop, finish: () => finish(), fail: (error) => fail(error) }
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

afterEach(() => {
  clearHandle()
  clearPendingStart()
})

describe('pendingStart', () => {
  it('is undefined when no start is under way', () => {
    // Scenario: nothing started, so a caller has no start to join.
    expect(pendingStart()).toBeUndefined()
  })

  it('returns the start that was published, through the global symbol registry', async () => {
    // Scenario: two copies of the library share only globalThis, so the start in progress is
    // published there, under a registry symbol, until it is cleared.
    const handle = createHandle(() => Promise.resolve())
    const start = Promise.resolve(handle)
    setPendingStart(start)
    expect(pendingStart()).toBe(start)
    const slot = (globalThis as Record<symbol, unknown>)[
      Symbol.for('@bymax-one/nest-telemetry/pending-start')
    ]
    expect(slot).toBe(start)
    clearPendingStart()
    expect(pendingStart()).toBeUndefined()
    await start
  })
})

describe('registerHandle and currentHandle', () => {
  it('returns undefined when nothing is registered', () => {
    // Scenario: telemetry never started, so there is nothing to drain.
    expect(currentHandle()).toBeUndefined()
  })

  it('returns the registered handle', () => {
    // Scenario: the preload registers, the application reads it back.
    const handle = createHandle(() => Promise.resolve())
    registerHandle(handle)
    expect(currentHandle()).toBe(handle)
  })

  it('shares the handle through the global symbol registry', () => {
    // Scenario: the preload and the application are separate module graphs that share only
    // globalThis; the handle lives under a registry symbol, not a string key.
    const handle = createHandle(() => Promise.resolve())
    registerHandle(handle)
    const slot = (globalThis as Record<symbol, unknown>)[
      Symbol.for('@bymax-one/nest-telemetry/handle')
    ]
    expect(slot).toBe(handle)
  })

  it('forgets the handle once cleared', () => {
    // Scenario: after shutdown the slot is empty again.
    registerHandle(createHandle(() => Promise.resolve()))
    clearHandle()
    expect(currentHandle()).toBeUndefined()
  })
})

describe('createHandle', () => {
  it('is enabled and not stopping before any shutdown', () => {
    // Scenario: a handle of a started SDK reports it is running.
    const handle = createHandle(() => Promise.resolve())
    expect(handle.enabled).toBe(true)
    expect(handle.stopping).toBe(false)
  })

  it('stops the SDK once however often shutdown is called in sequence', async () => {
    // Scenario: a repeated signal makes a second shutdown after the first settled.
    const stop = jest.fn(() => Promise.resolve())
    const handle = createHandle(stop)
    await handle.shutdown()
    await handle.shutdown()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(handle.stopping).toBe(false)
  })

  it('makes overlapping callers await the same flush', async () => {
    // Scenario: two shutdown hooks overlap; the second must not resolve while the flush the first
    // started is still pending, or a caller that awaits it could exit with spans unsent.
    const { stop, finish } = deferredStop()
    const handle = createHandle(stop)
    const resolved: string[] = []
    const first = handle.shutdown().then(() => resolved.push('first'))
    const second = handle.shutdown().then(() => resolved.push('second'))
    await settle()
    expect(resolved).toEqual([])
    expect(handle.stopping).toBe(true)
    finish()
    await Promise.all([first, second])
    expect(resolved).toEqual(['first', 'second'])
    expect(stop).toHaveBeenCalledTimes(1)
    expect(handle.stopping).toBe(false)
  })

  it('shares a failed flush between overlapping callers, and resolves later calls', async () => {
    // Scenario: the collector refuses the final export; every caller waiting on that flush sees
    // the failure, and a call after it settled does not retry.
    const { stop, fail } = deferredStop()
    const handle = createHandle(stop)
    const first = handle.shutdown()
    const second = handle.shutdown()
    fail(new Error('refused'))
    await expect(first).rejects.toThrow('refused')
    await expect(second).rejects.toThrow('refused')
    await expect(handle.shutdown()).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('stays registered while the flush is pending and clears itself once it settles', async () => {
    // Scenario: shutdownTelemetry during the flush must still find the handle to await.
    const { stop, finish } = deferredStop()
    const handle = createHandle(stop)
    registerHandle(handle)
    const flush = handle.shutdown()
    await settle()
    expect(currentHandle()).toBe(handle)
    finish()
    await flush
    expect(currentHandle()).toBeUndefined()
  })

  it('clears its registration even when the flush fails', async () => {
    // Scenario: a failed flush must not leave a dead handle registered.
    const handle = createHandle(() => Promise.reject(new Error('refused')))
    registerHandle(handle)
    await expect(handle.shutdown()).rejects.toThrow('refused')
    expect(currentHandle()).toBeUndefined()
  })

  it('leaves another registered handle alone when it settles', async () => {
    // Scenario: a second copy of the library registered its own handle meanwhile.
    const handle = createHandle(() => Promise.resolve())
    const other: RunningHandle = {
      enabled: true,
      stopping: false,
      shutdown: () => Promise.resolve()
    }
    registerHandle(handle)
    registerHandle(other)
    await handle.shutdown()
    expect(currentHandle()).toBe(other)
  })
})

describe('hasStopped', () => {
  it('is false until a started SDK has been shut down', () => {
    // Scenario: a process that never stopped an SDK may start one.
    expect(hasStopped()).toBe(false)
    createHandle(() => Promise.resolve())
    expect(hasStopped()).toBe(false)
  })

  it('stays false while the flush is pending and becomes true when it settles', async () => {
    // Scenario: the mark means the SDK is gone, not that it is going.
    const { stop, finish } = deferredStop()
    const handle = createHandle(stop)
    const flush = handle.shutdown()
    expect(hasStopped()).toBe(false)
    finish()
    await flush
    expect(hasStopped()).toBe(true)
  })

  it('becomes true when the flush fails too', async () => {
    // Scenario: a flush the collector refused still leaves the SDK shut down and its modules patched.
    const handle = createHandle(() => Promise.reject(new Error('refused')))
    await expect(handle.shutdown()).rejects.toThrow('refused')
    expect(hasStopped()).toBe(true)
  })

  it('is shared through the global symbol registry, so another copy of the module sees it', async () => {
    // Scenario: the preload's copy shut the SDK down, and the application's copy must refuse.
    await createHandle(() => Promise.resolve()).shutdown()
    const store = globalThis as typeof globalThis & Record<symbol, unknown>
    expect(store[Symbol.for('@bymax-one/nest-telemetry/stopped')]).toBe(true)
  })

  it('is forgotten when the registry is cleared', async () => {
    // Scenario: a test harness resets the process-wide state between cases, through this module.
    await createHandle(() => Promise.resolve()).shutdown()
    clearHandle()
    expect(hasStopped()).toBe(false)
  })
})

describe('shutdownTelemetry', () => {
  it('resolves without effect when nothing is registered', async () => {
    // Scenario: tracing disabled, so the application's shutdown hook is a no-op.
    await expect(shutdownTelemetry()).resolves.toBeUndefined()
  })

  it('shuts the registered handle down', async () => {
    // Scenario: the application drains the SDK the preload started.
    const stop = jest.fn(() => Promise.resolve())
    registerHandle(createHandle(stop))
    await shutdownTelemetry()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('waits for a flush another caller started', async () => {
    // Scenario: a signal handler started the flush and the application's hook calls
    // shutdownTelemetry while it is pending; the hook must not resolve early.
    const { stop, finish } = deferredStop()
    const handle = createHandle(stop)
    registerHandle(handle)
    const direct = handle.shutdown()
    let resolved = false
    const viaApi = shutdownTelemetry().then(() => {
      resolved = true
    })
    await settle()
    expect(resolved).toBe(false)
    finish()
    await Promise.all([direct, viaApi])
    expect(resolved).toBe(true)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('propagates a failed shutdown to the caller', async () => {
    // Scenario: the caller (the Nest hook) decides what a refused flush means; the library does
    // not swallow it.
    registerHandle(createHandle(() => Promise.reject(new Error('collector refused'))))
    await expect(shutdownTelemetry()).rejects.toThrow('collector refused')
  })
})
