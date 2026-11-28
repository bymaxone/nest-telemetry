/**
 * @fileoverview Tests the settling of the guarded `send`: a send that throws, a send that answers with no promise,
 * a refusal whose result has no prototype, and a `then` that something replaced, which must not settle the result.
 * @layer sdk
 */
import { guardExports } from './export-guard'
import { pollutedNames } from './prototype-guard'

jest.mock('./prototype-guard', () => ({ pollutedNames: jest.fn(() => 0) }))

type Done = (result: { code: number; error?: unknown }) => void
type Send = (data: unknown, timeout: unknown) => unknown

const polluted = jest.mocked(pollutedNames)

/** Runs `run` while a getter on `Promise.prototype.constructor` throws, as a `then` reads it for a species. */
function whileConstructorThrows<T>(run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(
    Promise.prototype,
    'constructor'
  ) as PropertyDescriptor
  Object.defineProperty(Promise.prototype, 'constructor', {
    configurable: true,
    get(): never {
      throw new Error('hostile constructor')
    }
  })
  try {
    return run()
  } finally {
    Object.defineProperty(Promise.prototype, 'constructor', original)
  }
}

/**
 * Waits for `promise` the way a native `await` does: the `then` of the engine is applied while
 * `Promise.prototype.constructor` is a getter that throws, because that is when a caller reads the constructor of
 * what the library handed back. The slot is restored at once, before anything else runs.
 */
function awaitedWhileConstructorThrows<T>(promise: Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(
    Promise.prototype,
    'constructor'
  ) as PropertyDescriptor
  const then = Promise.prototype.then
  return new Promise<T>((resolve, reject) => {
    Object.defineProperty(Promise.prototype, 'constructor', {
      configurable: true,
      get(): never {
        throw new Error('hostile constructor')
      }
    })
    try {
      Reflect.apply(then, promise, [resolve, reject])
    } catch (error) {
      reject(error)
    } finally {
      Object.defineProperty(Promise.prototype, 'constructor', original)
    }
  })
}

beforeEach(() => {
  polluted.mockReset()
  polluted.mockReturnValue(0)
})

/** An OTLP-shaped exporter whose innermost transport sends with the function given. */
function exporterSending(
  send: Send,
  parameters: Record<string, unknown> = {}
): {
  send(data: unknown, timeout: unknown): Promise<unknown>
  _parameters: Record<string, (...args: unknown[]) => unknown>
} {
  class Inner {
    _parameters = parameters
    send = send
  }
  class Retrying {
    _transport = new Inner()
  }
  class Delegate {
    _transport = new Retrying()
  }
  class Base {
    _delegate = new Delegate()
    export(_items: unknown, done: Done): void {
      done({ code: 0 })
    }
  }
  class Sub extends Base {}
  const exporter = new Sub()
  guardExports(exporter)
  exporter.export([], () => undefined)
  return exporter._delegate._transport._transport as never
}

describe('the settling of a guarded send', () => {
  it('rejects, with the reason, when the send throws before it returns a promise', async () => {
    // Scenario: a send that throws synchronously becomes a rejected attempt carrying the original reason.
    const guarded = exporterSending(() => {
      throw new Error('send failed')
    })
    await expect(guarded.send('data', 1)).rejects.toThrow('send failed')
  })

  it('resolves with an answer that is not a promise, as it is', async () => {
    // Scenario: a transport that answers with a plain result is passed through unchanged.
    const guarded = exporterSending(() => ({ status: 'success' }))
    await expect(guarded.send('data', 1)).resolves.toEqual({ status: 'success' })
  })

  it('refuses with a result that has no prototype, so resolving it reads no then from the root', async () => {
    // Scenario: the refused result is an object that inherits nothing; a `then` that a root prototype holds is
    // not reachable from it.
    const guarded = exporterSending(() => ({ status: 'success' }))
    polluted.mockReturnValue(1)
    const refused = (await guarded.send('data', 1)) as object
    expect(Object.getPrototypeOf(refused)).toBeNull()
    expect(refused).toMatchObject({ status: 'failure' })
  })

  it('settles with the value the transport gave, whatever then something replaced after load', async () => {
    // Scenario: a `then` that was replaced after the library loaded would call the callback of a consumer with
    // a value of its own; the guard consumes the promise with the `then` it read when it loaded.
    const guarded = exporterSending(() => Promise.resolve({ status: 'success' }))
    const original = Promise.prototype.then
    const forged = { status: 'forged' }
    Promise.prototype.then = function (
      this: Promise<unknown>,
      onValue: (value: unknown) => unknown
    ): never {
      return original.call(this, () => onValue(forged)) as never
    } as never
    try {
      const settled = guarded.send('data', 1)
      // Read with the captured then, so the replaced one is not what delivers the value to this test.
      const value = await new Promise((resolve) => original.call(settled, resolve))
      expect(value).toEqual({ status: 'success' })
    } finally {
      Promise.prototype.then = original
    }
  })

  it('refuses a result that the transport gave while the process turned polluted, instead of resolving it', async () => {
    // Scenario: the transport answers after a name was planted: resolving with its object would read a `then` from
    // the root prototype, so the check runs right before the resolve and the result is the refusal.
    const guarded = exporterSending(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            polluted.mockReturnValue(1)
            resolve({ status: 'success' })
          }, 0)
        })
    )
    const settled = await guarded.send('data', 1)
    expect(settled).toMatchObject({ status: 'failure' })
    expect(Object.getPrototypeOf(settled)).toBeNull()
  })

  it('answers with what the transport sent when the constructor of promises throws as it is awaited', async () => {
    // Scenario: a getter on Promise.prototype.constructor throws when the guard waits for the promise the transport
    // answered with; the promise took an own constructor first, so the getter is not reached and the result arrives.
    const guarded = exporterSending(() => Promise.resolve({ status: 'success' }))
    const settled = whileConstructorThrows(() => guarded.send('data', 1))
    await expect(settled).resolves.toEqual({ status: 'success' })
  })

  it('rejects with the reason of the transport when a constructor getter erases itself after one read', async () => {
    // Scenario: the transport plants a getter on Promise.prototype.constructor that throws once and removes itself, and
    // answers with a rejecting promise; the promise took an own constructor first, so the getter is not read, the
    // rejection is handled and the attempt fails with the transport's own reason.
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const reason = new Error('send failed')
    const original = Object.getOwnPropertyDescriptor(
      Promise.prototype,
      'constructor'
    ) as PropertyDescriptor
    const guarded = exporterSending(() => {
      const sent = Promise.reject(reason)
      Object.defineProperty(Promise.prototype, 'constructor', {
        configurable: true,
        get(): never {
          Object.defineProperty(Promise.prototype, 'constructor', original)
          throw new Error('hostile constructor')
        }
      })
      return sent
    })
    try {
      const result = guarded.send('data', 1)
      // Put back before anything of the test reads the slot: the library's own wait is the one under examination.
      Object.defineProperty(Promise.prototype, 'constructor', original)
      await expect(result).rejects.toBe(reason)
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      Object.defineProperty(Promise.prototype, 'constructor', original)
      process.off('unhandledRejection', unhandled)
    }
    expect(unhandled).not.toHaveBeenCalled()
  })

  it('answers a provider thenable through a promise of its own whose constructor is not read', async () => {
    // Scenario: a provider answers with a thenable that is not a promise; the guard adopts it into a promise it made,
    // which has its own constructor, so a throwing getter on the prototype is not reached and the value arrives.
    const guarded = exporterSending(() => ({ status: 'success' }), {
      headers: () => ({ then: (resolve: (value: unknown) => void): void => resolve({ a: '1' }) })
    })
    const settled = whileConstructorThrows(() => guarded._parameters['headers']?.())
    await expect(settled).resolves.toEqual({ a: '1' })
  })

  it('rejects a provider promise of the host that cannot be consumed, and does not pass its value on', async () => {
    // Scenario: the host's provider answers with a native promise and the constructor getter throws when the guard
    // attaches to it; the host's promise is not written to, and the answer is refused.
    const guarded = exporterSending(() => ({ status: 'success' }), {
      headers: () => Promise.resolve({ a: '1' })
    })
    const settled = whileConstructorThrows(() => guarded._parameters['headers']?.())
    await expect(settled).rejects.toMatchObject({ code: 'BYMAX_TELEMETRY_REALM_POLLUTED' })
  })

  it('names the pollution when a provider promise is dropped and the constructor getter throws', () => {
    // Scenario: the prototype is polluted and the provider answered with a native promise; attaching the handler that
    // drops it throws under the planted getter, and the guard still throws the pollution error, not the getter's.
    const guarded = exporterSending(() => ({ status: 'success' }), {
      headers: () => Promise.resolve({ a: '1' })
    })
    polluted.mockReturnValue(0)
    const provider = guarded._parameters['headers'] as () => unknown
    polluted.mockReturnValueOnce(0).mockReturnValue(1)
    expect(() => whileConstructorThrows(provider)).toThrow(
      'Object.prototype or a built-in of this process was changed, so the batch was dropped.'
    )
  })

  it('hands back a send that the transport awaits after the constructor of promises was replaced', async () => {
    // Scenario: the transport awaits the promise the guard returned, after the guard's last check; its own
    // constructor ends the lookup, so the result arrives and the host's getter is never called.
    const guarded = exporterSending(() => Promise.resolve({ status: 'success' }))
    const answer = guarded.send('data', 1)
    await expect(awaitedWhileConstructorThrows(answer)).resolves.toEqual({ status: 'success' })
  })

  it('hands back a provider answer that the transport awaits after the constructor was replaced', async () => {
    // Scenario: the request awaits the headers the guarded provider returned for a thenable, under the replaced slot.
    const guarded = exporterSending(() => ({ status: 'success' }), {
      headers: () => ({ then: (resolve: (value: unknown) => void): void => resolve({ a: '1' }) })
    })
    const answer = guarded._parameters['headers']?.() as Promise<unknown>
    await expect(awaitedWhileConstructorThrows(answer)).resolves.toEqual({ a: '1' })
  })
})
