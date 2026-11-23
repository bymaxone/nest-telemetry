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

  it('arms the sending transport as a writable, configurable method and marks it with the value true', () => {
    // Scenario: a host library that wraps the same send after this one must be able to, and the marker that keeps
    // a transport from being armed twice is the value true on its own symbol.
    const { exporter, inner } = shaped()
    exporter.export(['batch'], () => undefined)
    const send = Object.getOwnPropertyDescriptor(inner, 'send') as PropertyDescriptor
    expect(send.writable).toBe(true)
    expect(send.configurable).toBe(true)
    const mark = Object.getOwnPropertyDescriptor(
      inner,
      Symbol.for('@bymax-one/nest-telemetry/export-guard/transport')
    ) as PropertyDescriptor
    expect(mark.value).toBe(true)
    const headers = Object.getOwnPropertyDescriptor(
      (inner as unknown as { _parameters: object })._parameters,
      'headers'
    ) as PropertyDescriptor
    expect([headers.writable, headers.configurable, headers.enumerable]).toEqual([true, true, true])
  })

  it('follows at most eight transports, and arms the eighth, never a ninth', () => {
    // Scenario: a chain of transports that each hold the next stops at eight hops, so one that is deeper is not
    // walked to its end: the eighth is armed and the ninth is not.
    const key = Symbol.for('@bymax-one/nest-telemetry/export-guard/transport')
    const chain: { send: () => undefined; _transport?: unknown }[] = []
    for (let at = 0; at < 10; at += 1) chain.push({ send: () => undefined })
    for (let at = 0; at < 9; at += 1)
      (chain[at] as { _transport?: unknown })._transport = chain[at + 1]
    class Base {
      _delegate = chain[0]
      export(_items: unknown, done: Done): void {
        done({ code: 0 })
      }
    }
    class Sub extends Base {}
    const exporter = new Sub()
    guardExports(exporter)
    exporter.export([], () => undefined)
    expect(Object.hasOwn(chain[8] as object, key)).toBe(true)
    expect(Object.hasOwn(chain[9] as object, key)).toBe(false)
  })

  it('does not arm a function, and does not wrap a provider named undefined', () => {
    // Scenario: a delegate that is a function is not a transport, and a parameters object that owns a function
    // spelled 'undefined' is not read as one more provider.
    class Base {
      _delegate = Object.assign(() => undefined, { send: () => undefined })
      export(_items: unknown, done: Done): void {
        done({ code: 0 })
      }
    }
    class Sub extends Base {}
    const exporter = new Sub()
    guardExports(exporter)
    exporter.export([], () => undefined)
    expect(
      Object.getOwnPropertySymbols(exporter._delegate).filter((symbol) =>
        String(symbol).includes('export-guard/transport')
      )
    ).toHaveLength(0)
    const { exporter: shapedExporter, inner } = shaped()
    const parameters = (inner as unknown as { _parameters: Record<string, unknown> })._parameters
    const named = (): number => 1
    parameters['undefined'] = named
    shapedExporter.export([], () => undefined)
    expect(parameters['undefined']).toBe(named)
  })

  it('wraps a base class whose mark is not a data property holding true', () => {
    // Scenario: a mark that is an accessor, or a data property holding anything but true, does not say the class is
    // wrapped, so the class is wrapped.
    for (const mark of [
      { get: () => true, configurable: true },
      { value: 'yes', configurable: true },
      { value: false, configurable: true }
    ]) {
      class Base {
        export(_items: unknown, done: Done): void {
          done({ code: 0 })
        }
      }
      class Sub extends Base {}
      Object.defineProperty(
        Base.prototype,
        Symbol.for('@bymax-one/nest-telemetry/export-guard'),
        mark
      )
      const exporter = new Sub()
      guardExports(exporter)
      polluted.mockReturnValue(1)
      const results: number[] = []
      exporter.export([], (result) => results.push(result.code))
      polluted.mockReturnValue(0)
      expect(results).toEqual([1])
    }
  })

  it('leaves an object that cannot send untouched', () => {
    // Scenario: a transport with no send function is not armed: it gains no wrapper and no marker.
    class Base {
      _delegate = { _transport: {} }
      export(_items: unknown, done: Done): void {
        done({ code: 0 })
      }
    }
    class Sub extends Base {}
    const exporter = new Sub()
    guardExports(exporter)
    exporter.export([], () => undefined)
    expect(Reflect.ownKeys(exporter._delegate._transport)).toEqual([])
  })

  describe('a provider that answers after it waited', () => {
    /** An exporter whose transport holds one provider, armed by an export, and that provider as the guard wrapped it. */
    function armed(provider: (...args: unknown[]) => unknown): () => unknown {
      class Base {
        _delegate = { _transport: { send: () => undefined, _parameters: { headers: provider } } }
        export(_items: unknown, done: Done): void {
          done({ code: 0 })
        }
      }
      class Sub extends Base {}
      const exporter = new Sub()
      guardExports(exporter)
      exporter.export([], () => undefined)
      return exporter._delegate._transport._parameters.headers as () => unknown
    }

    it('refuses an asynchronous answer when a name was planted while the provider waited, and passes it on a clean prototype', async () => {
      // Scenario: a host-supplied headers provider waits, a name is planted meanwhile, and the request that would
      // follow its answer is refused: the answer rejects with the refusal, and nothing is read from it.
      const clean = armed(() => Promise.resolve({ authorization: 'x' }))
      await expect(clean()).resolves.toEqual({ authorization: 'x' })
      const waiting = armed(async () => {
        await Promise.resolve()
        polluted.mockReturnValue(1)
        return { authorization: 'x' }
      })
      await expect(waiting()).rejects.toThrow(
        'The Object.prototype of this process is polluted, so the batch was dropped.'
      )
    })

    it('waits for any thenable, and refuses it the same way', async () => {
      // Scenario: an answer that is not a native promise but has a then is awaited too.
      const thenable = { then: (resolve: (value: number) => void): void => resolve(5) }
      const clean = armed(() => thenable)
      await expect(clean()).resolves.toBe(5)
      const planted = armed(() => ({
        then: (resolve: (value: number) => void): void => {
          polluted.mockReturnValue(2)
          resolve(5)
        }
      }))
      await expect(planted()).rejects.toThrow('so the batch was dropped')
    })

    it('hands a synchronous answer back as it is, and refuses it when the provider itself planted a name', () => {
      // Scenario: a synchronous provider stays synchronous (gRPC reads its metadata and credentials that way), and
      // an object whose then is not a function, a function that has a then, null and a text are not waited for.
      const plain = { then: 'not a function' }
      expect(armed(() => plain)()).toBe(plain)
      expect(armed(() => null)()).toBeNull()
      expect(armed(() => 'text')()).toBe('text')
      const callable = Object.assign(() => 1, { then: (): undefined => undefined })
      expect(armed(() => callable)()).toBe(callable)
      const planting = armed(() => {
        polluted.mockReturnValue(1)
        return 'answer'
      })
      expect(() => planting()).toThrow('so the batch was dropped')
    })

    it('refuses before it reads anything from the answer, so a getter named then is never run', () => {
      // Scenario: a polluted root prototype can give an answer a getter called then; the check comes first, so the
      // refusal is thrown and the getter is not run.
      let reads = 0
      const answer = {}
      Object.defineProperty(answer, 'then', {
        get: (): undefined => {
          reads += 1
          return undefined
        }
      })
      const planting = armed(() => {
        polluted.mockReturnValue(1)
        return answer
      })
      expect(() => planting()).toThrow('so the batch was dropped')
      expect(reads).toBe(0)
    })
  })
})
