/**
 * @fileoverview Tests that every attempt of an exporter's transport is checked, before it starts and again just
 * before it reads its headers, metadata or credentials, and that an exporter of another shape is left alone.
 * @layer sdk
 */
import { guardExports } from './export-guard'
import { pollutedNames } from './prototype-guard'

jest.mock('./prototype-guard', () => ({ pollutedNames: jest.fn(() => 0) }))

type Done = (result: { code: number; error?: unknown }) => void

const polluted = jest.mocked(pollutedNames)

beforeEach(() => {
  polluted.mockReset()
  polluted.mockReturnValue(0)
})

/** An exporter shaped as the OTLP ones are: a delegate, a retrying transport, and the transport that sends. */
function shaped(): {
  exporter: { export(items: unknown, done: Done): void }
  inner: { send(data: unknown, timeout: unknown): Promise<unknown> }
  sends: unknown[][]
  calls: string[]
} {
  const sends: unknown[][] = []
  const calls: string[] = []
  class Inner {
    _parameters = {
      headers: function (this: unknown, ...args: unknown[]): unknown {
        calls.push(`headers:${String(args[0])}:${this === (Inner as unknown) ? 'x' : 'ok'}`)
        return { 'x-header': 'value' }
      },
      metadata: (): unknown => {
        calls.push('metadata')
        return 'metadata'
      },
      credentials: (): unknown => {
        calls.push('credentials')
        return 'credentials'
      },
      address: 'not-a-function'
    }
    async send(data: unknown, timeout: unknown): Promise<unknown> {
      sends.push([data, timeout])
      return { status: 'success' }
    }
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
  return { exporter, inner: exporter._delegate._transport._transport, sends, calls }
}

describe('a transport behind a guarded exporter', () => {
  it('sends an attempt on a clean prototype, and refuses one, with no send and no retry, on a polluted one', async () => {
    // Scenario: the attempt that a retrying transport makes after a back-off goes through the same send as the
    // first, so a name planted while it waited is seen: the result is a failure, not a retryable one, and the
    // transport behind it is not reached.
    const { exporter, inner, sends } = shaped()
    exporter.export(['batch'], () => undefined)
    await expect(inner.send('data', 5)).resolves.toEqual({ status: 'success' })
    expect(sends).toEqual([['data', 5]])
    polluted.mockReturnValue(2)
    const refused = (await inner.send('later', 5)) as { status: string; error: Error }
    expect(refused.status).toBe('failure')
    expect(refused.error.message).toBe(
      'The Object.prototype of this process is polluted, so the batch was dropped.'
    )
    expect(sends).toHaveLength(1)
  })

  it('refuses to read the headers, the metadata or the credentials while the prototype is polluted', () => {
    // Scenario: a transport reads them after it loaded what it needs, which is after the check of the attempt; a
    // name planted in between is seen, the read throws, and nothing is sent. A clean prototype reads as before,
    // with the arguments and the receiver the transport passes.
    const { exporter, inner, calls } = shaped()
    exporter.export(['batch'], () => undefined)
    const parameters = (
      inner as unknown as { _parameters: Record<string, (...a: unknown[]) => unknown> }
    )._parameters
    expect(parameters['headers']?.('a')).toEqual({ 'x-header': 'value' })
    expect(parameters['metadata']?.()).toBe('metadata')
    expect(parameters['credentials']?.()).toBe('credentials')
    expect(calls).toEqual(['headers:a:ok', 'metadata', 'credentials'])
    polluted.mockReturnValue(1)
    for (const name of ['headers', 'metadata', 'credentials']) {
      expect(() => parameters[name]?.()).toThrow('so the batch was dropped')
    }
    expect(calls).toHaveLength(3)
    expect(parameters['address']).toBe('not-a-function')
  })

  it('guards the transport once, however many exports are made', () => {
    // Scenario: a second export does not stack a second wrapper on the attempt or on the providers: one send asks
    // the guard once.
    const { exporter, inner } = shaped()
    exporter.export(['one'], () => undefined)
    exporter.export(['two'], () => undefined)
    polluted.mockClear()
    return inner.send('data', 1).then(() => {
      expect(polluted).toHaveBeenCalledTimes(1)
    })
  })

  it('leaves an exporter of another shape alone, and does not hang on a transport that points at itself', () => {
    // Scenario: an exporter with no delegate, a delegate with no transport, a transport that cannot send, one with
    // no parameters or with providers that are not functions, and a chain that loops, are each exported through
    // without a throw.
    class Base {
      export(_items: unknown, done: Done): void {
        done({ code: 0 })
      }
    }
    class Sub extends Base {}
    const bare = new Sub()
    guardExports(bare)
    const shapes: Record<string, unknown>[] = [
      {},
      { _delegate: {} },
      { _delegate: { _transport: {} } },
      { _delegate: { _transport: { send: () => undefined } } },
      { _delegate: { _transport: { send: () => undefined, _parameters: { headers: 'no' } } } },
      { _delegate: null },
      { _delegate: 'text' }
    ]
    const loop: { send(): void; _transport?: unknown } = { send: () => undefined }
    loop._transport = loop
    shapes.push({ _delegate: { _transport: loop } })
    for (const shape of shapes) {
      const exporter = Object.assign(new Sub(), shape)
      expect(() => exporter.export(['x'], () => undefined)).not.toThrow()
    }
  })

  it('does not read a name from the prototype of the exporter or its transport', () => {
    // Scenario: a delegate or a transport that a polluted root prototype would supply is not followed: only own
    // properties are read.
    class Base {
      export(_items: unknown, done: Done): void {
        done({ code: 0 })
      }
    }
    class Sub extends Base {}
    Object.defineProperty(Object.prototype, '_delegate', {
      value: { _transport: { send: () => undefined } },
      configurable: true,
      writable: true
    })
    try {
      const exporter = new Sub()
      guardExports(exporter)
      exporter.export(['x'], () => undefined)
      const planted = (Object.prototype as unknown as { _delegate: { _transport: object } })
        ._delegate
      expect(Object.hasOwn(planted._transport, 'send')).toBe(true)
      expect(Object.getOwnPropertySymbols(planted._transport)).toHaveLength(0)
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['_delegate']
    }
  })
})
