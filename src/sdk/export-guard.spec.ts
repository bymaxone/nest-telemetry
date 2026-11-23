/**
 * @fileoverview Tests that an export is dropped, with no I/O, while Object.prototype is polluted, and that the
 * wrap is made once, on the base class only.
 * @layer sdk
 */
import { guardExports } from './export-guard'
import { pollutedNames } from './prototype-guard'

jest.mock('./prototype-guard', () => ({ pollutedNames: jest.fn(() => 0) }))

type Done = (result: { code: number; error?: unknown }) => void
type Exporter = { export(items: unknown, done: Done): void }

const polluted = jest.mocked(pollutedNames)

beforeEach(() => {
  polluted.mockReset()
  polluted.mockReturnValue(0)
})

/** An exporter base class and one that extends it, counting what reaches the base. */
function exporters(): { sent: unknown[]; make: () => Exporter; base: object } {
  const sent: unknown[] = []
  class Base {
    export(items: unknown, done: Done): void {
      sent.push(items)
      done({ code: 0 })
    }
  }
  class Sub extends Base {}
  return { sent, make: () => new Sub(), base: Base.prototype }
}

describe('guardExports', () => {
  it('sends on a clean prototype and drops, with a failed result and no send, on a polluted one', () => {
    // Scenario: the wrapped export passes a batch through when nothing is planted and answers FAILED, without
    // reaching the exporter, when a name is planted; the error says why and repeats no name.
    const { sent, make } = exporters()
    const exporter = make()
    guardExports(exporter)
    const results: { code: number; error?: unknown }[] = []
    exporter.export(['clean'], (result) => results.push(result))
    expect(sent).toEqual([['clean']])
    expect(results).toEqual([{ code: 0 }])
    polluted.mockReturnValue(3)
    exporter.export(['dropped'], (result) => results.push(result))
    expect(sent).toEqual([['clean']])
    expect(results[1]?.code).toBe(1)
    expect((results[1]?.error as Error).message).toBe(
      'The Object.prototype of this process is polluted, so the batch was dropped.'
    )
  })

  it('gives the dropped batch an own code that names the pollution, even when a setter for code and a property named get are planted', () => {
    // Scenario: the error of a dropped batch carries the code that lets the failure warning name the
    // cause; the code is defined, not assigned, so a planted setter or descriptor name cannot stop it.
    const { make } = exporters()
    const exporter = make()
    guardExports(exporter)
    polluted.mockReturnValue(1)
    Object.defineProperty(Object.prototype, 'code', {
      configurable: true,
      set(_value: unknown): void {
        void _value
      }
    })
    Object.defineProperty(Object.prototype, 'get', { configurable: true, value: () => 'x' })
    try {
      let seen: unknown
      exporter.export([], (result) => (seen = result.error))
      expect(Object.getOwnPropertyDescriptor(seen, 'code')?.value).toBe(
        'BYMAX_TELEMETRY_REALM_POLLUTED'
      )
    } finally {
      delete (Object.prototype as Record<string, unknown>).code
      delete (Object.prototype as Record<string, unknown>).get
    }
  })

  it('defines every wrap and mark with a descriptor that a name planted on the root prototype cannot change', () => {
    // Scenario: a property named get planted on Object.prototype is read as the getter of a descriptor
    // literal, which then holds a value beside a getter and is invalid, so the definition would throw at
    // the wrap and at each arming of a transport.
    const sends: unknown[] = []
    const transport = {
      send: (data: unknown): Promise<unknown> => {
        sends.push(data)
        return Promise.resolve({ status: 'success' })
      },
      _parameters: { headers: (): Record<string, string> => ({}) }
    }
    class Base {
      export(_items: unknown, done: Done): void {
        done({ code: 0 })
      }
    }
    class Sub extends Base {
      _delegate = { _transport: transport }
    }
    const exporter = new Sub()
    Object.defineProperty(Object.prototype, 'get', { value: () => 1, configurable: true })
    try {
      expect(() => guardExports(exporter)).not.toThrow()
      const results: { code: number }[] = []
      expect(() => exporter.export(['a'], (result) => results.push(result))).not.toThrow()
      expect(results).toEqual([{ code: 0 }])
      expect(Object.getOwnPropertyDescriptor(transport, 'send')?.writable).toBe(true)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'get')
    }
  })

  it('decides to drop, and to send, with the then of Promise replaced by a function that throws', () => {
    // Scenario: a host wrapped Promise.prototype.then; the decision to drop or to send reads no then, so the
    // batch is dropped when polluted and sent when clean, and the replacement is never called.
    const { sent, make } = exporters()
    const exporter = make()
    guardExports(exporter)
    const original = Object.getOwnPropertyDescriptor(
      Promise.prototype,
      'then'
    ) as PropertyDescriptor
    let calls = 0
    Object.defineProperty(Promise.prototype, 'then', {
      ...original,
      value: (): never => {
        calls += 1
        throw new Error('replaced then must not run')
      }
    })
    try {
      const results: { code: number }[] = []
      exporter.export(['clean'], (result) => results.push(result))
      polluted.mockReturnValue(1)
      exporter.export(['dropped'], (result) => results.push(result))
      expect(results.map((result) => result.code)).toEqual([0, 1])
      expect(sent).toEqual([['clean']])
      expect(calls).toBe(0)
    } finally {
      Object.defineProperty(Promise.prototype, 'then', original)
    }
  })

  it('wraps a base class once, however many exporters ask, and reaches every exporter that extends it', () => {
    // Scenario: a second exporter of the same base, and a second call for the same one, do not stack a wrapper:
    // one export asks the guard once.
    const { sent, make } = exporters()
    const first = make()
    const second = make()
    guardExports(first)
    guardExports(first)
    guardExports(second)
    second.export(['once'], () => undefined)
    expect(sent).toEqual([['once']])
    expect(polluted).toHaveBeenCalledTimes(1)
    polluted.mockReturnValue(1)
    second.export(['dropped'], () => undefined)
    expect(sent).toHaveLength(1)
  })

  it('leaves the wrapped method writable and configurable, so a host can still wrap it', () => {
    // Scenario: another library that wraps the same method after this one must be able to.
    const { make, base } = exporters()
    guardExports(make())
    const descriptor = Object.getOwnPropertyDescriptor(base, 'export') as PropertyDescriptor
    expect(descriptor.writable).toBe(true)
    expect(descriptor.configurable).toBe(true)
  })

  it('does nothing, and changes no prototype, for an object that has no base class with an export', () => {
    // Scenario: a plain object, an object with no prototype and an object of a class whose base has no
    // export are left alone: nothing throws and nothing is put on Object.prototype or on the class.
    class Alone {}
    class NoExport extends Alone {}
    expect(() => guardExports({})).not.toThrow()
    expect(() => guardExports(Object.create(null) as object)).not.toThrow()
    expect(() => guardExports(new NoExport())).not.toThrow()
    expect(Object.hasOwn(Object.prototype, 'export')).toBe(false)
    expect(Object.hasOwn(Alone.prototype, 'export')).toBe(false)
  })
})
