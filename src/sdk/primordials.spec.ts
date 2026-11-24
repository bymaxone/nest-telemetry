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

  it('takes the prototype from the engine, so a replaced global does not move what the guard watches', () => {
    // Scenario: a host replaces `globalThis.Promise` with a subclass before load; the prototype the guard watches is
    // still the engine's, and not the subclass's.
    const real = globalThis.Promise
    class Zoneish extends (real as unknown as new (executor: () => void) => object) {}
    let loaded: { promisePrototype: unknown; NativePromise: unknown } | undefined
    jest.isolateModules(() => {
      globalThis.Promise = Zoneish as unknown as PromiseConstructor
      try {
        loaded = jest.requireActual('./primordials') as typeof loaded
      } finally {
        globalThis.Promise = real
      }
    })
    expect(loaded?.promisePrototype).toBe(real.prototype)
    expect(loaded?.promisePrototype).not.toBe(Zoneish.prototype)
  })

  it('takes the slot as it is, a value planted there, and one from a fresh realm when it is gone', () => {
    // Scenario: the constructor slot holds a function, or was deleted, before load, with the global replaced; the
    // capture reads the data property, neither throws nor runs a getter, and a missing slot falls back to a fresh
    // realm's constructor, never to the global one, so the guard can refuse the process.
    const realGlobal = globalThis.Promise
    const original = Object.getOwnPropertyDescriptor(
      realGlobal.prototype,
      'constructor'
    ) as PropertyDescriptor
    const planted = function Planted(): void {}
    const captured: unknown[] = []
    const Replaced = function Replaced(): void {}
    globalThis.Promise = Replaced as unknown as PromiseConstructor
    try {
      for (const slot of [{ ...original, value: planted }, undefined]) {
        if (slot === undefined) Reflect.deleteProperty(realGlobal.prototype, 'constructor')
        else Object.defineProperty(realGlobal.prototype, 'constructor', slot)
        jest.isolateModules(() => {
          captured.push(
            (jest.requireActual('./primordials') as { NativePromise: unknown }).NativePromise
          )
        })
      }
    } finally {
      globalThis.Promise = realGlobal
      Object.defineProperty(realGlobal.prototype, 'constructor', original)
    }
    expect(captured[0]).toBe(planted)
    expect(typeof captured[1]).toBe('function')
    expect(captured[1]).not.toBe(Replaced)
    expect(captured[1]).not.toBe(realGlobal)
  })
})
