/**
 * @fileoverview Tests how `primordials` takes the `Promise` intrinsic the guard builds its promises from.
 * @layer sdk
 */
describe('the Promise the guard builds from', () => {
  it('is the intrinsic, and not a global binding that was replaced before the library loaded', () => {
    // Scenario: the host replaces `globalThis.Promise` before this library loads; the promises the guard settles
    // are still built from the engine's own constructor.
    const real = globalThis.Promise
    class Replaced {}
    let loaded: unknown
    jest.isolateModules(() => {
      globalThis.Promise = Replaced as never
      try {
        loaded = (jest.requireActual('./primordials') as { NativePromise: unknown }).NativePromise
      } finally {
        globalThis.Promise = real
      }
    })
    expect(loaded).toBe(real)
    expect(loaded).not.toBe(Replaced)
  })
})
