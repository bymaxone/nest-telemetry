/**
 * @fileoverview Tests that a warning reaches `process.emitWarning` with options that own what Node reads, and
 * that a warning Node cannot build is dropped.
 * @layer sdk
 */
import { emitWarning } from './emit-warning'

afterEach(() => {
  jest.restoreAllMocks()
})

describe('emitWarning', () => {
  it('hands the text, the type and the code over, with an own empty detail and an own ctor', () => {
    // Scenario: Node reads detail and ctor from the options and assigns the detail onto the warning; the options
    // own both, so nothing a polluted root prototype holds under those names is read or printed.
    const spy = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    emitWarning('text of the warning', { type: 'SecurityWarning', code: 'BYMAX_TELEMETRY_X' })
    expect(spy).toHaveBeenCalledTimes(1)
    const [text, options] = spy.mock.calls[0] as [string, Record<string, unknown>]
    expect(text).toBe('text of the warning')
    expect(Object.keys(options).sort()).toEqual(['code', 'ctor', 'detail', 'type'])
    expect(options).toEqual({ type: 'SecurityWarning', code: 'BYMAX_TELEMETRY_X', detail: '' })
  })

  it('drops the warning, and does not throw, when Node cannot build it', () => {
    // Scenario: process.emitWarning throws (a read-only detail on the root prototype does that): the caller, often
    // an export callback or a start, carries on.
    jest.spyOn(process, 'emitWarning').mockImplementation(() => {
      throw new TypeError('Cannot assign to read only property')
    })
    expect(() => emitWarning('text', { type: 'Warning', code: 'BYMAX_TELEMETRY_X' })).not.toThrow()
  })
})
