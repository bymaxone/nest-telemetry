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
import { clearWarningSink, registerWarningSink } from './warning-sink'

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

describe('createHandle shutdown deadline', () => {
  const CODE = 'BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT'

  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('resolves with a warning when the flush has not finished within the default deadline', async () => {
    // Scenario: a collector that accepts the export and never answers must not hold shutdown past
    // the deadline, so a container's termination grace period is never spent on it.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const { stop } = deferredStop()
    const settled = jest.fn()
    const done = createHandle(stop).shutdown().then(settled)
    await jest.advanceTimersByTimeAsync(4999)
    expect(settled).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await done
    expect(settled).toHaveBeenCalledTimes(1)
    expect(emitWarning).toHaveBeenCalledTimes(1)
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('did not finish within 5000 ms'),
      {
        type: 'Warning',
        code: CODE
      }
    )
  })

  it('hands the timeout to a registered warning sink, with the deadline, instead of printing it', async () => {
    // Scenario: a bound logger takes the warning, so the timeout is structured and alertable and is
    // not also printed as a process warning. The sink still stands when the deadline passes.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const sink = jest.fn(() => true)
    registerWarningSink(sink)
    try {
      const { stop } = deferredStop()
      const done = createHandle(stop, 250).shutdown()
      await jest.advanceTimersByTimeAsync(250)
      await done
      expect(sink).toHaveBeenCalledTimes(1)
      expect(sink).toHaveBeenCalledWith(
        expect.objectContaining({ code: CODE, fields: { timeoutMs: 250 } })
      )
      expect(emitWarning).not.toHaveBeenCalled()
    } finally {
      clearWarningSink()
    }
  })

  it('uses the deadline the host passes', async () => {
    // Scenario: shutdownTimeoutMs lets a host fit its own grace period.
    jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const { stop } = deferredStop()
    const settled = jest.fn()
    const done = createHandle(stop, 250).shutdown().then(settled)
    await jest.advanceTimersByTimeAsync(249)
    expect(settled).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await done
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 120001, 3_600_000])(
    'falls back to the default deadline for an unusable value (%p)',
    async (value) => {
      // Scenario: a typo must neither disable the deadline nor recreate the hang it guards against,
      // so zero, a negative, a non-number and anything above two minutes mean the default.
      jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
      const { stop } = deferredStop()
      const settled = jest.fn()
      const done = createHandle(stop, value).shutdown().then(settled)
      await jest.advanceTimersByTimeAsync(4999)
      expect(settled).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(1)
      await done
      expect(settled).toHaveBeenCalledTimes(1)
    }
  )

  it('accepts the largest usable deadline', async () => {
    // Scenario: the cap is inclusive, so a host that really wants two minutes gets them.
    jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const { stop } = deferredStop()
    const settled = jest.fn()
    const done = createHandle(stop, 120_000).shutdown().then(settled)
    await jest.advanceTimersByTimeAsync(119_999)
    expect(settled).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await done
    expect(settled).toHaveBeenCalledTimes(1)
  })

  it('warns nothing and clears its timer when the flush finishes in time', async () => {
    // Scenario: the healthy path leaves no timer behind and no warning.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const { stop, finish } = deferredStop()
    const done = createHandle(stop).shutdown()
    finish()
    await done
    expect(jest.getTimerCount()).toBe(0)
    expect(emitWarning).not.toHaveBeenCalled()
  })

  it('still rejects with the failure of a flush that fails before the deadline', async () => {
    // Scenario: a quick, definite failure is the caller's to see, as before; only a hang is cut.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const { stop, fail } = deferredStop()
    const done = createHandle(stop).shutdown()
    const outcome = expect(done).rejects.toThrow('refused')
    fail(new Error('refused'))
    await outcome
    expect(jest.getTimerCount()).toBe(0)
    expect(emitWarning).not.toHaveBeenCalled()
  })

  it('does not keep the process alive for the deadline', () => {
    // Scenario: the timer is a safety net, never a reason for the process to wait.
    const unref = jest.spyOn(global, 'setTimeout')
    createHandle(deferredStop().stop)
      .shutdown()
      .catch(() => undefined)
    const timer = unref.mock.results[unref.mock.results.length - 1]?.value as { hasRef(): boolean }
    expect(timer.hasRef()).toBe(false)
    unref.mockRestore()
  })

  it('marks the SDK as stopped and clears its registration at the deadline', async () => {
    // Scenario: a restart must stay refused and the registry must not hold a handle whose flush the
    // caller already moved past, whichever way the flush ends.
    jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const { stop } = deferredStop()
    const handle = createHandle(stop)
    registerHandle(handle)
    const done = handle.shutdown()
    expect(hasStopped()).toBe(false)
    await jest.advanceTimersByTimeAsync(5000)
    await done
    expect(hasStopped()).toBe(true)
    expect(currentHandle()).toBeUndefined()
    expect(handle.stopping).toBe(false)
  })

  it('absorbs the rejection of a flush that fails after the deadline', async () => {
    // Scenario: the background shutdown cannot be cancelled, and when it finally fails nobody is
    // waiting, so the failure must not surface as an unhandled rejection.
    jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const { stop, fail } = deferredStop()
    const done = createHandle(stop).shutdown()
    await jest.advanceTimersByTimeAsync(5000)
    await done
    fail(new Error('late'))
    jest.useRealTimers()
    await settle()
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
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
