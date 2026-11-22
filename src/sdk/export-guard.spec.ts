/**
 * @fileoverview Tests that an export is dropped, with no I/O, while Object.prototype is polluted.
 * @layer sdk
 */
import { guardExports } from './export-guard'

type Done = (result: { code: number; error?: unknown }) => void

/** An exporter base class and one that extends it, counting what reaches the base. */
function exporters(): { sent: unknown[]; make: () => object; Base: { prototype: object } } {
  const sent: unknown[] = []
  class Base {
    export(items: unknown, done: Done): void {
      sent.push(items)
      done({ code: 0 })
    }
  }
  class Sub extends Base {}
  return { sent, make: () => new Sub(), Base }
}

/** Plants an enumerable name for the length of `run`. */
function polluted(run: () => void): void {
  Object.defineProperty(Object.prototype, 'plantedForTheTest', {
    value: 'x',
    enumerable: true,
    configurable: true,
    writable: true
  })
  try {
    run()
  } finally {
    delete (Object.prototype as unknown as Record<string, unknown>)['plantedForTheTest']
  }
}

describe('guardExports', () => {
  it('sends on a clean prototype and drops, with a failed result and no send, on a polluted one', () => {
    // Scenario: the wrapped export passes a batch through when nothing is planted and answers FAILED, without
    // reaching the exporter, when a name is planted; the error repeats no name.
    const { sent, make } = exporters()
    const exporter = make() as { export(items: unknown, done: Done): void }
    guardExports(exporter)
    const results: { code: number; error?: unknown }[] = []
    exporter.export(['clean'], (result) => results.push(result))
    expect(sent).toEqual([['clean']])
    expect(results).toEqual([{ code: 0 }])
    polluted(() => {
      exporter.export(['dropped'], (result) => results.push(result))
    })
    expect(sent).toEqual([['clean']])
    expect(results[1]?.code).toBe(1)
    expect(String((results[1]?.error as Error).message)).not.toContain('plantedForTheTest')
  })

  it('wraps a base class once, whichever exporters ask, and reaches every exporter that extends it', () => {
    // Scenario: a second exporter of the same base, and a second call for the same one, do not stack a wrapper.
    const { sent, make } = exporters()
    const first = make() as { export(items: unknown, done: Done): void }
    const second = make() as { export(items: unknown, done: Done): void }
    guardExports(first)
    guardExports(first)
    guardExports(second)
    second.export(['once'], () => undefined)
    expect(sent).toEqual([['once']])
    polluted(() => {
      second.export(['dropped'], () => undefined)
    })
    expect(sent).toHaveLength(1)
  })

  it('does nothing for an object that has no base class with an export', () => {
    // Scenario: a plain object, or an exporter of another shape, is left alone and nothing throws.
    expect(() => guardExports({})).not.toThrow()
    expect(() => guardExports(Object.create(null) as object)).not.toThrow()
    expect(() => guardExports(new (class Alone {})())).not.toThrow()
  })
})
