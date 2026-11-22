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
