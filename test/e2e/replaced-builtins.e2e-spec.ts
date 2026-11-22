/**
 * @fileoverview Pins, in a real Node process, that no built-in the guard or the export wrap calls is looked up
 * when they run: each function and getter of the global objects is replaced in turn, after the bundle loaded,
 * and a name is planted; the guard must still count it, the wrap must still drop the batch with no send, and
 * nothing that was replaced may be called.
 * @layer e2e
 */
import { runInNewContext } from 'node:vm'

import { pollutedNames } from '../../src/sdk/prototype-guard'

import { bundleSdk, runInRealProcess } from './fixtures/real-process'
import type { SdkBundle } from './fixtures/real-process'

let bundle: SdkBundle

beforeAll(() => {
  bundle = bundleSdk('test/e2e/fixtures/guard-entry.ts')
}, 120_000)

afterAll(() => {
  bundle.remove()
})

/**
 * The child script. It reads everything it needs before it replaces anything, replaces one target at a time,
 * runs the check while the target is replaced, restores it, and reports only after all are restored.
 */
const CHILD = `
const { pollutedNames, guardExports } = require(process.env.BUNDLE)
const defineProperty = Object.defineProperty
const ownKeys = Reflect.ownKeys
const getDescriptor = Object.getOwnPropertyDescriptor
const getNames = Object.getOwnPropertyNames
const root = Object.prototype
const log = console.log.bind(console)
const stringify = JSON.stringify
let called = 0
const stand = function () { called = called + 1; return undefined }

// What the guard must do, with one target replaced: count one planted name, drop an exported batch with no
// send, count nothing and send on a clean prototype, and wrap an exporter built after the replacement.
const guardCheck = () => {
  const out = { clean: -1, planted: -1, sent: -1, code: -1, cleanSent: -1, cleanCode: -1 }
  class Base { export(items, done) { out.sent = out.sent + 1; done({ code: 0 }) } }
  class Sub extends Base {}
  const exporter = new Sub()
  guardExports(exporter)
  out.sent = 0
  out.clean = pollutedNames()
  exporter.export([1], (r) => { out.cleanCode = r.code })
  out.cleanSent = out.sent
  out.sent = 0
  root.zzplanted = 'x'
  out.planted = pollutedNames()
  exporter.export([1], (r) => { out.code = r.code })
  delete root.zzplanted
  return out
}
// A check that reads two built-ins when it runs, to show the harness sees a call.
const liveCheck = () => {
  Object.hasOwn({}, 'a')
  new Set().add(1)
  return { clean: 0, planted: 1, sent: 0, code: 1, cleanSent: 1, cleanCode: 0 }
}

const targets = []
const groups = [
  ['Object', Object], ['Reflect', Reflect], ['Function.prototype', Function.prototype],
  ['Array.prototype', Array.prototype], ['Array', Array], ['Set.prototype', Set.prototype], ['Set', Set],
  ['Map.prototype', Map.prototype], ['WeakMap.prototype', WeakMap.prototype], ['Symbol', Symbol],
  ['Symbol.prototype', Symbol.prototype], ['String.prototype', String.prototype], ['String', String],
  ['Number', Number], ['Error', Error], ['Error.prototype', Error.prototype], ['JSON', JSON], ['Math', Math],
  ['Promise', Promise], ['Promise.prototype', Promise.prototype], ['RegExp.prototype', RegExp.prototype],
  ['Boolean.prototype', Boolean.prototype], ['Number.prototype', Number.prototype], ['globalThis', globalThis]
]
for (const [label, group] of groups) {
  for (const key of ownKeys(group)) {
    const descriptor = getDescriptor(group, key)
    if (!descriptor.configurable) continue
    const isFunction = typeof descriptor.value === 'function'
    if (!isFunction && descriptor.get === undefined) continue
    if (group === globalThis && !/^[A-Z]/.test(String(key)) && key !== 'Reflect') continue
    targets.push({ label: label + '.' + String(key), group, key, descriptor, isFunction })
  }
}

const run = (check) => {
  const results = []
  for (const target of targets) {
    const { group, key, descriptor, isFunction } = target
    called = 0
    defineProperty(group, key, isFunction
      ? { value: stand, writable: true, configurable: true, enumerable: descriptor.enumerable }
      : { get: stand, set: descriptor.set, configurable: true, enumerable: descriptor.enumerable })
    let out
    let threw = false
    try { out = check() } catch (error) { threw = true }
    const calls = called
    defineProperty(group, key, descriptor)
    delete root.zzplanted
    results.push({ label: target.label, calls, threw, out })
  }
  return results
}
const wrong = (r) => r.threw || r.calls !== 0 || r.out.clean !== 0 || r.out.cleanSent !== 1 || r.out.cleanCode !== 0 ||
  r.out.planted !== 1 || r.out.sent !== 0 || r.out.code !== 1
const real = run(guardCheck).filter(wrong).map((r) => r.label)
const control = run(liveCheck).filter((r) => r.calls !== 0).map((r) => r.label)
log(stringify({ targets: targets.length, wrong: real, control }))
`

describe('a built-in that something replaces after the library loaded', () => {
  it('is never called by the guard or the export wrap, and the refusal stands', async () => {
    // Scenario: every function and getter of the global objects, and each global constructor, is replaced in turn
    // after the bundle loaded; with a name planted the guard still counts it and the wrap still drops the batch
    // with no send, an exporter wrapped after the replacement is guarded too, a clean prototype still exports,
    // and the replacement is never called.
    const result = await runInRealProcess(CHILD, { BUNDLE: bundle.file }, 60_000)
    const report = JSON.parse(result.lines[result.lines.length - 1] ?? '{}') as {
      targets: number
      wrong: string[]
      control: string[]
    }
    expect(report.wrong).toEqual([])
    expect(report.targets).toBeGreaterThan(300)
    expect(result.code).toBe(0)
  }, 90_000)

  it('is seen by the harness when a check does call it, so a clean report means something', async () => {
    // Scenario: the same harness, run with a check that reads Object.hasOwn and a Set method when it runs, lists
    // both as called: a guard that looked a built-in up would not pass the test above.
    const result = await runInRealProcess(CHILD, { BUNDLE: bundle.file }, 60_000)
    const report = JSON.parse(result.lines[result.lines.length - 1] ?? '{}') as {
      control: string[]
    }
    expect(report.control).toEqual(expect.arrayContaining(['Object.hasOwn', 'Set.prototype.add']))
    expect(report.control).toEqual(expect.arrayContaining(['globalThis.Set']))
  }, 90_000)

  it('counts a name the engine defines that was made looser, swapped for the same function of another realm, or for one with other text', () => {
    // Scenario: __proto__ turned into a writable data property counts one, valueOf replaced by the identical-looking
    // native function of a fresh realm counts one, toString replaced by a function with other text counts one, and the
    // prototype counts zero again once each is restored.
    const root = Object.prototype
    const proto = Object.getOwnPropertyDescriptor(root, '__proto__') as PropertyDescriptor
    const value = Object.getOwnPropertyDescriptor(root, 'valueOf') as PropertyDescriptor
    expect(pollutedNames()).toBe(0)
    try {
      Object.defineProperty(root, '__proto__', {
        value: 1,
        writable: true,
        configurable: true,
        enumerable: false
      })
      expect(pollutedNames()).toBe(1)
    } finally {
      Object.defineProperty(root, '__proto__', proto)
    }
    try {
      Object.defineProperty(root, 'valueOf', {
        ...value,
        value: runInNewContext('Object.prototype.valueOf') as unknown
      })
      expect(pollutedNames()).toBe(1)
    } finally {
      Object.defineProperty(root, 'valueOf', value)
    }
    const tighter = Object.getOwnPropertyDescriptor(root, 'isPrototypeOf') as PropertyDescriptor
    try {
      Object.defineProperty(root, 'isPrototypeOf', { writable: false })
      expect(pollutedNames()).toBe(0)
    } finally {
      Object.defineProperty(root, 'isPrototypeOf', tighter)
    }
    const text = Object.getOwnPropertyDescriptor(root, 'toString') as PropertyDescriptor
    try {
      Object.defineProperty(root, 'toString', { ...text, value: () => 'planted' })
      expect(pollutedNames()).toBe(1)
    } finally {
      Object.defineProperty(root, 'toString', text)
    }
    expect(pollutedNames()).toBe(0)
  })

  it('counts nothing for a name the engine defines that was missing when the library loaded and is back, as it was defined', () => {
    // Scenario: a library copy that loaded while isPrototypeOf was deleted has no snapshot of it; once the name is
    // back, as the engine defines it, the copy counts zero.
    const root = Object.prototype
    const own = Object.getOwnPropertyDescriptor(root, 'isPrototypeOf') as PropertyDescriptor
    Reflect.deleteProperty(root, 'isPrototypeOf')
    let late: typeof pollutedNames | undefined
    try {
      jest.isolateModules(() => {
        late = (require('../../src/sdk/prototype-guard') as { pollutedNames: typeof pollutedNames })
          .pollutedNames
      })
    } finally {
      Object.defineProperty(root, 'isPrototypeOf', own)
    }
    expect(late?.()).toBe(0)
  })
})
