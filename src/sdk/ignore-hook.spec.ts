/**
 * @fileoverview Tests for the guard around the host's ignore hook.
 * @layer sdk
 */
import { guardIgnoreHook } from './ignore-hook'

const CODE = 'BYMAX_TELEMETRY_IGNORE_HOOK_ASYNC'
const request = { url: '/orders' }

/** The codes of the process warnings emitted so far. */
function codes(emitWarning: jest.SpyInstance): unknown[] {
  return emitWarning.mock.calls.map(([, options]) => (options as { code?: string }).code)
}

describe('guardIgnoreHook', () => {
  let emitWarning: jest.SpyInstance

  beforeEach(() => {
    emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([true, false, undefined, null, 0, 'yes'])(
    'hands a synchronous answer of %p over as it is',
    (answer) => {
      // Scenario: what a synchronous hook returns is the instrumentation's to judge, as before.
      const hook = jest.fn(() => answer)
      expect(guardIgnoreHook(hook)(request)).toBe(answer)
      expect(hook).toHaveBeenCalledWith(request)
      expect(codes(emitWarning)).toEqual([])
    }
  )

  it('hands over an object that has no then method', () => {
    // Scenario: only a callable `then` makes an answer asynchronous.
    const answer = { then: 'later' }
    expect(guardIgnoreHook(() => answer)(request)).toBe(answer)
    expect(codes(emitWarning)).toEqual([])
  })

  it('keeps the receiver the instrumentation calls the hook with', () => {
    // Scenario: the instrumentation calls the hook as a method of its configuration.
    const config = {
      ignored: true,
      hook: guardIgnoreHook(function (this: { ignored: boolean }) {
        return this.ignored
      })
    }
    expect(config.hook(request)).toBe(true)
  })

  it('lets a synchronous throw through', () => {
    // Scenario: the instrumentation catches it and traces the request, as before.
    const hook = guardIgnoreHook(() => {
      throw new Error('sync')
    })
    expect(() => hook(request)).toThrow('sync')
    expect(codes(emitWarning)).toEqual([])
  })

  it.each([true, false])('does not ignore a request for a promise of %p', (value) => {
    // Scenario: a promise is truthy, so an async hook would otherwise drop every request.
    expect(guardIgnoreHook(() => Promise.resolve(value))(request)).toBe(false)
  })

  it('takes the rejection of a promise and reports it once', async () => {
    // Scenario: an unhandled rejection would end the process of the host.
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const hook = guardIgnoreHook(() => Promise.reject(new Error('secret')))
    expect([hook(request), hook(request)]).toEqual([false, false])
    await new Promise((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    expect(codes(emitWarning)).toEqual([CODE])
    expect(String(emitWarning.mock.calls[0]?.[0])).toContain('ignoreIncomingRequest')
    expect(String(emitWarning.mock.calls[0]?.[0])).not.toContain('secret')
  })

  it('takes the rejection of a promise whose own then is not callable', async () => {
    // Scenario: it is still a promise, so it must neither ignore the request nor stay unhandled.
    const unhandled = jest.fn()
    process.on('unhandledRejection', unhandled)
    const answer = Promise.reject(new Error('shadowed'))
    Object.defineProperty(answer, 'then', { value: undefined })
    expect(guardIgnoreHook(() => answer)(request)).toBe(false)
    await new Promise((resolve) => setImmediate(resolve))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    expect(codes(emitWarning)).toEqual([CODE])
  })

  it.each([
    ['an object', {}],
    ['a function', (): void => undefined]
  ])('calls the then of a thenable that is %s, with the thenable as receiver', (_kind, target) => {
    // Scenario: a promise of another library is absorbed through its own then.
    const then = jest.fn(function (this: unknown, _value: unknown, onReason: (e: Error) => void) {
      expect(this).toBe(answer)
      onReason(new Error('rejected'))
    })
    const answer = Object.assign(target, { then })
    expect(guardIgnoreHook(() => answer)(request)).toBe(false)
    expect(then).toHaveBeenCalledWith(expect.any(Function), expect.any(Function))
    expect(codes(emitWarning)).toEqual([CODE])
  })

  it('does not ignore the request when the then of a thenable throws', () => {
    // Scenario: a broken thenable must not turn into an exception of the hook.
    const answer = {
      then: (): never => {
        throw new Error('broken')
      }
    }
    expect(guardIgnoreHook(() => answer)(request)).toBe(false)
    expect(codes(emitWarning)).toEqual([CODE])
  })
})
