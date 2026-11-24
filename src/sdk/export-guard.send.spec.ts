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

beforeEach(() => {
  polluted.mockReset()
  polluted.mockReturnValue(0)
})

/** An OTLP-shaped exporter whose innermost transport sends with the function given. */
function exporterSending(send: Send): { send(data: unknown, timeout: unknown): Promise<unknown> } {
  class Inner {
    _parameters = {}
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
    // Scenario: a send that throws synchronously is a rejected attempt, as it was when the wrapper was async.
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
})
