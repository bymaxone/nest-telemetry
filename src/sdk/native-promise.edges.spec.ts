/**
 * @fileoverview Tests the edges of the native wait: a promise whose prototype is not the engine's, and the error of a
 * wait that cannot be made.
 * @layer sdk
 */
import { absorbHost, unconsumable } from './native-promise'

describe('a wait on a promise whose prototype is not the engine one', () => {
  it('attaches through the captured then, so a then the promise holds is not called', async () => {
    // Scenario: a promise of a subclass has no own constructor and a prototype that is not Promise.prototype, so a bare
    // await would read its constructor, find another function and call the then it holds; the wait goes through the
    // then captured at load, and the then planted on the promise is never called.
    class Derived<T> extends Promise<T> {}
    const host = Derived.resolve('real')
    const planted = jest.fn()
    Object.defineProperty(host, 'then', { value: planted, configurable: true })
    const got = await new Promise<unknown>((resolve) => {
      expect(absorbHost(host, resolve, resolve)).toBe(true)
    })
    expect(got).toBe('real')
    expect(planted).not.toHaveBeenCalled()
  })
})

describe('the error of a wait that cannot be made', () => {
  it('says that the constructor of the promise was replaced, and carries the pollution code', () => {
    // Scenario: the caller of a refused wait fails with this text and a code of its own, not a generic error.
    const error = unconsumable()
    expect(error.message).toBe(
      'A promise of the host could not be waited for, because its constructor was replaced.'
    )
    expect(error).toMatchObject({ code: 'BYMAX_TELEMETRY_REALM_POLLUTED' })
  })
})
