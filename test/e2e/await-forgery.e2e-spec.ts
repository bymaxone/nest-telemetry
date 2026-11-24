/**
 * @fileoverview Runs a start in a real Node process while something replaces the promise machinery after the
 * library loaded, and checks that no forged package is built into the SDK: a `Promise.all` that was replaced, a
 * `then` that erases itself after one read, and a replaced `then` with a constructor that is read once.
 * @layer e2e
 */
import { bundleSdk, runInRealProcess } from './fixtures/real-process'
import type { SdkBundle } from './fixtures/real-process'

/** The child: starts telemetry after one of the replacements was made, and reports what was built. */
const CHILD = `
const O = Promise
const thenOfNative = O.prototype.then
const built = { forged: 0 }
const packages = async () => O.all([
  import('@opentelemetry/sdk-node'), import('@opentelemetry/sdk-trace'),
  import('@opentelemetry/auto-instrumentations-node'), import('@opentelemetry/exporter-trace-otlp-http'),
  import('@opentelemetry/resources')
])
;(async () => {
  const { startTelemetry } = require(process.env.BUNDLE)
  const real = await packages()
  const forgedSdk = { ...real[0], NodeSDK: class { constructor() { built.forged += 1 } start() {} shutdown() { return O.resolve() } } }
  const forgedList = [forgedSdk, real[1], real[2], real[3], real[4]]
  const scenario = process.env.SCENARIO
  if (scenario === 'all') {
    Promise.all = () => O.resolve(forgedList)
  }
  if (scenario === 'h1') {
    const then = O.prototype.then
    const original = Object.getOwnPropertyDescriptor(O.prototype, 'constructor')
    class Fake extends O {}
    const restore = () => {
      O.prototype.then = then
      Object.defineProperty(O.prototype, 'constructor', original)
    }
    O.prototype.then = function (onValue, onReason) {
      return then.call(this, typeof onValue !== 'function' ? onValue : (v) => {
        if (!(Array.isArray(v) && v.length === 5 && v[0] && v[0].NodeSDK)) return onValue(v)
        restore()
        return onValue(forgedList)
      }, onReason)
    }
    Object.defineProperty(O.prototype, 'constructor', { configurable: true, get() { return Fake } })
  }
  if (scenario === 'ctor') {
    const hostile = Object.getOwnPropertyDescriptor(O.prototype, 'constructor')
    Object.defineProperty(O.prototype, 'constructor', { configurable: true, get() {
      if (String(new Error().stack).includes(process.env.BUNDLE)) throw new Error('hostile constructor')
      return hostile.value
    } })
  }
  if (scenario === 'h2-before') {
    Object.defineProperty(Object.prototype, 'then', { configurable: true, get() { delete Object.prototype.then; return function (resolve) { resolve({ enabled: true, forged: true }) } } })
  }
  const started = startTelemetry({ env: { OTEL_SERVICE_NAME: 'forgery', OTEL_EXPORTER_OTLP_ENDPOINT: process.env.ENDPOINT } })
  if (scenario === 'h2') {
    Object.defineProperty(Object.prototype, 'then', { configurable: true, get() { delete Object.prototype.then; return function (resolve) { resolve(forgedList) } } })
  }
  const report = (handle, error) => {
    console.log(JSON.stringify({ forged: built.forged, enabled: Boolean(handle) && handle.enabled === true, rejected: error ? error.message : null }))
    process.exit(0)
  }
  Reflect.apply(thenOfNative, started, [(handle) => report(handle, null), (error) => report(null, error)])
  setTimeout(() => report(null, null), 10000)
})()
`

describe('a start while the promise machinery was replaced after load', () => {
  let bundle: SdkBundle
  beforeAll(() => {
    bundle = bundleSdk()
  })
  afterAll(() => bundle.remove())

  const measure = async (
    scenario: string
  ): Promise<{ forged: number; enabled: boolean; rejected: string | null }> => {
    const result = await runInRealProcess(
      CHILD,
      { BUNDLE: bundle.file, SCENARIO: scenario, ENDPOINT: 'http://127.0.0.1:1' },
      60_000
    )
    return JSON.parse(result.lines[result.lines.length - 1] ?? '{}') as {
      forged: number
      enabled: boolean
      rejected: string | null
    }
  }

  it('starts the SDK from the loaded packages when nothing was replaced', async () => {
    // Scenario: the control; the child builds the real SDK and the forged constructor is not run.
    expect(await measure('clean')).toEqual({ forged: 0, enabled: true, rejected: null })
  })

  it('builds no forged package when Promise.all was replaced after load', async () => {
    // Scenario: a Promise.all that answers with a package list of its own is never consulted by the start.
    expect((await measure('all')).forged).toBe(0)
  })

  it('builds no forged package when a then that erases itself is read after the packages arrive', async () => {
    // Scenario: a getter on Object.prototype that deletes itself on its first read and resolves with a forged
    // package list is planted while the packages load; no value is resolved through it, so nothing forged is built.
    expect((await measure('h2')).forged).toBe(0)
  })

  it('builds no forged package when then was replaced and the constructor is replaced and restored', async () => {
    // Scenario: a replaced Promise.prototype.then forges the five-package list, and a constructor getter on the
    // prototype puts itself back after one read, so an await would take the slow path through the replaced then;
    // the start consumes the imports with the then it read at load and awaits nothing.
    expect((await measure('h1')).forged).toBe(0)
  })

  it('answers a refused start with the disabled handle, not with a value a planted then resolves it to', async () => {
    // Scenario: a getter on Object.prototype that erases itself on its first read is planted before the start; the
    // start is refused, and the handle it answers with has no prototype, so the getter is never read from it and the
    // caller gets the disabled handle and not the forged object.
    expect(await measure('h2-before')).toEqual({ forged: 0, enabled: false, rejected: null })
  })

  it('refuses a start, and does not fail, when the constructor of Promise.prototype throws for the library', async () => {
    // Scenario: a getter on Promise.prototype.constructor throws for a read from the bundle; the imports are consumed
    // through promises that have their own constructor, so the load reaches the pollution check, which refuses.
    expect(await measure('ctor')).toEqual({ forged: 0, enabled: false, rejected: null })
  })
})
