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
const { GUARDED_BUILTINS, buildRedactedQueryParams, pollutedNames, guardExports, settleOptions, warnOnExportFailure, exportFailureCount, registerWarningSink, clearWarningSink, describeFailure } = require(process.env.BUNDLE)
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
  const out = { clean: -1, planted: -1, sent: -1, code: -1, cleanSent: -1, cleanCode: -1, headers: -1, refused: -1 }
  class Base {
    _delegate = { _transport: { _transport: { send: () => undefined, _parameters: { headers: () => 7 } } } }
    export(items, done) { out.sent = out.sent + 1; done({ code: 0 }) }
  }
  class Sub extends Base {}
  const exporter = new Sub()
  guardExports(exporter)
  out.sent = 0
  out.clean = pollutedNames()
  exporter.export([1], (r) => { out.cleanCode = r.code })
  out.cleanSent = out.sent
  try { out.headers = exporter._delegate._transport._transport._parameters.headers() } catch (error) { out.headers = 0 }
  out.sent = 0
  root.zzplanted = 'x'
  out.planted = pollutedNames()
  exporter.export([1], (r) => { out.code = r.code })
  try { exporter._delegate._transport._transport._parameters.headers(); out.refused = 0 } catch (error) { out.refused = 1 }
  delete root.zzplanted
  return out
}
// What the option settling must do with one target replaced: keep every option the host gave, a switch that is
// off, a list, a nested override and a hook included.
const optionsCheck = () => {
  const hook = () => undefined
  const settled = settleOptions({
    enabled: false,
    serviceName: 'svc',
    extraRedactedQueryParams: ['a', 'b'],
    instrumentations: { overrides: { http: { enabled: false, requestHook: hook, redactedQueryParams: ['q'], nested: { deep: [1, { x: 2 }] } } } }
  })
  const tagged = []
  tagged.note = 'metadata, not an entry'
  const empty = settleOptions({ extraRedactedQueryParams: tagged }).extraRedactedQueryParams
  const http = settled.instrumentations && settled.instrumentations.overrides && settled.instrumentations.overrides.http
  return {
    enabled: settled.enabled === false ? 1 : 0,
    name: settled.serviceName === 'svc' ? 1 : 0,
    list: settled.extraRedactedQueryParams && settled.extraRedactedQueryParams.length === 2 ? 1 : 0,
    off: http && http.enabled === false ? 1 : 0,
    hook: http && http.requestHook === hook ? 1 : 0,
    nested: http && http.nested && http.nested.deep[1].x === 2 ? 1 : 0,
    tagged: empty && empty.length === 0 ? 1 : 0
  }
}
// What a failed export must do with one target replaced: tell the caller, count the failure and warn once.
const failureCheck = () => {
  const out = { done: -1, counted: -1, warned: -1 }
  const warnings = {}
  let seen = 0
  const remove = registerWarningSink((warning) => { warnings[seen] = warning.code; seen = seen + 1; return true })
  const before = exportFailureCount()
  const exporter = warnOnExportFailure({ export: (items, done) => done({ code: 1, error: { code: 'ECONNREFUSED' } }) }, 'k')
  exporter.export([1], (r) => { out.done = r.code })
  out.counted = exportFailureCount() - before
  out.warned = seen === 1 && warnings[0] === 'BYMAX_TELEMETRY_EXPORT_FAILED' ? 1 : 0
  remove()
  return out
}
// A check that reads two built-ins when it runs, to show the harness sees a call.
const liveCheck = () => {
  Object.hasOwn({}, 'a')
  new Set().add(1)
  return { clean: 0, planted: 1, sent: 0, code: 1, cleanSent: 1, cleanCode: 0, headers: 7, refused: 1 }
}

const targets = []
const arrayIterator = Object.getPrototypeOf([][Symbol.iterator]())
const setIterator = Object.getPrototypeOf(new Set()[Symbol.iterator]())
const groups = [
  ['ArrayIteratorPrototype', arrayIterator, 'Object.getPrototypeOf([][Symbol.iterator]())'],
  ['SetIteratorPrototype', setIterator, 'Object.getPrototypeOf(new Set()[Symbol.iterator]())'],
  ['Object', Object], ['Reflect', Reflect], ['Function.prototype', Function.prototype],
  ['Array.prototype', Array.prototype], ['Array', Array], ['Set.prototype', Set.prototype], ['Set', Set],
  ['Map.prototype', Map.prototype], ['WeakMap.prototype', WeakMap.prototype], ['Symbol', Symbol],
  ['Symbol.prototype', Symbol.prototype], ['String.prototype', String.prototype], ['String', String],
  ['Number', Number], ['Error', Error], ['Error.prototype', Error.prototype], ['JSON', JSON], ['Math', Math],
  ['Promise', Promise], ['Promise.prototype', Promise.prototype], ['RegExp.prototype', RegExp.prototype],
  ['Boolean.prototype', Boolean.prototype], ['Number.prototype', Number.prototype], ['globalThis', globalThis],
  ['performance', performance]
]
for (const [label, group, expression] of groups) {
  for (const key of ownKeys(group)) {
    const descriptor = getDescriptor(group, key)
    if (!descriptor.configurable) continue
    const isFunction = typeof descriptor.value === 'function'
    if (!isFunction && descriptor.get === undefined) continue
    if (group === globalThis && !/^[A-Z]/.test(String(key)) && key !== 'Reflect' && key !== 'performance') continue
    targets.push({ label: label + '.' + String(key), owner: expression ?? label, group, key, descriptor, isFunction })
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
    results.push({ label: target.label, owner: target.owner, key, calls, threw, out })
  }
  return results
}
// The members the guard compares with a fresh realm: replacing one is a refusal, whatever the root prototype
// holds. Promise, timers, Date and the others a host wraps by design are not in the table, and still export.
// The members that decision paths reach with no call in the source, by iterating: a for...of, a spread, a
// destructuring or new Set(list). Named here, apart from the table, so a row that fell out of the table fails.
const ITERATED = [
  'ArrayIteratorPrototype.next', 'Array.prototype.Symbol(Symbol.iterator)', 'SetIteratorPrototype.next',
  'Set.prototype.Symbol(Symbol.iterator)', 'Set.prototype.add'
]
// A slot the guard compares by identity with the one it loaded with, a data property rather than a table row.
const WATCHED = ['Promise.prototype.constructor']
const guarded = (r) => {
  if (ITERATED.includes(r.label) || WATCHED.includes(r.label)) return true
  // The global Promise is replaced by hosts by design; the guard reads the intrinsic it captured, and its species.
  if (r.owner === 'globalThis' && r.key === 'Promise') return false
  if (r.owner === 'globalThis') return GUARDED_BUILTINS.some(([expression]) => expression === String(r.key) || expression === String(r.key) + '.prototype')
  return GUARDED_BUILTINS.some(([expression, names]) => expression === r.owner && names.includes(r.key))
}
const wrong = (r) => guarded(r)
  ? r.threw || r.calls !== 0 || r.out.clean === 0 || r.out.cleanSent !== 0 || r.out.cleanCode !== 1 ||
    r.out.planted < 1 || r.out.sent !== 0 || r.out.code !== 1
  : r.threw || r.calls !== 0 || r.out.clean !== 0 || r.out.cleanSent !== 1 || r.out.cleanCode !== 0 ||
    r.out.planted !== 1 || r.out.sent !== 0 || r.out.code !== 1 || r.out.headers !== 7 || r.out.refused !== 1
// What an iteration that was emptied does to redaction, and what the guard does about it: the list of redacted
// query parameters comes back empty, so the guard must count it and a wrapped exporter must drop its batch.
const iterationCases = [
  ['ArrayIteratorPrototype.next', arrayIterator, 'next', () => ({ done: true })],
  ['Array.prototype[Symbol.iterator]', Array.prototype, Symbol.iterator, () => ({ next: () => ({ done: true }) })],
  ['SetIteratorPrototype.next', setIterator, 'next', () => ({ done: true })]
]
const iteration = []
for (const [label, group, key, replacement] of iterationCases) {
  const descriptor = getDescriptor(group, key)
  const out = { label, params: -1, counted: -1, sent: -1, code: -1 }
  class Base {
    _delegate = { _transport: { _transport: { send: () => undefined, _parameters: { headers: () => 7 } } } }
    export(items, done) { out.sent = out.sent + 1; done({ code: 0 }) }
  }
  class Sub extends Base {}
  const exporter = new Sub()
  guardExports(exporter)
  out.sent = 0
  defineProperty(group, key, { ...descriptor, value: replacement })
  try {
    out.params = buildRedactedQueryParams(['x']).length
    out.counted = pollutedNames()
    exporter.export([1], (r) => { out.code = r.code })
  } finally {
    defineProperty(group, key, descriptor)
  }
  iteration.push(out)
}
// What naming a failed start must do with one target replaced: the code and the package its message names.
const describeCheck = () => ({
  named: describeFailure({ code: 'ERR_X', message: 'Cannot find @opentelemetry/sdk-node' }) === 'code ERR_X, package @opentelemetry/sdk-node' ? 1 : 0
})
const wrongOptions = (r) => r.threw || r.calls !== 0 || Object.values(r.out).some((v) => v !== 1)
const wrongFailure = (r) => r.threw || r.calls !== 0 || r.out.done !== 1 || r.out.counted !== 1 || r.out.warned !== 1
const described = run(describeCheck).filter(wrongOptions).map((r) => r.label)
const real = run(guardCheck).filter(wrong).map((r) => r.label)
const options = run(optionsCheck).filter(wrongOptions).map((r) => r.label)
const failure = run(failureCheck).filter(wrongFailure).map((r) => r.label)
const control = run(liveCheck).filter((r) => r.calls !== 0).map((r) => r.label)
log(stringify({ targets: targets.length, wrong: real, options, failure, described, control, iteration }))
`

describe('a built-in that something replaces after the library loaded', () => {
  it('is never called by the guard or the export wrap, and the refusal stands', async () => {
    // Scenario: every function and getter of the global objects, and each global constructor, is replaced in turn
    // after the bundle loaded; with a name planted the guard still counts it and the wrap still drops the batch
    // with no send, an exporter wrapped after the replacement is guarded too, and the replacement is never
    // called. A replaced member of the guard's table (Array, String, Map, Set, RegExp and Number prototypes, and
    // the statics of Object, JSON, Reflect, Symbol, Number and Array) refuses even on a clean prototype; every
    // other target, Promise, timers and Date included, is wrapped by hosts by design and still exports.
    const result = await runInRealProcess(CHILD, { BUNDLE: bundle.file }, 60_000)
    const report = JSON.parse(result.lines[result.lines.length - 1] ?? '{}') as {
      targets: number
      wrong: string[]
      options: string[]
      failure: string[]
      described: string[]
      control: string[]
      iteration: { label: string; params: number; counted: number; sent: number; code: number }[]
    }
    expect({
      wrong: report.wrong,
      options: report.options,
      failure: report.failure,
      described: report.described
    }).toEqual({ wrong: [], options: [], failure: [], described: [] })
    expect(report.targets).toBeGreaterThan(300)
    expect(result.code).toBe(0)
  }, 90_000)

  it('refuses a batch while an iterator that redaction relies on answers nothing, with the redacted list already empty', async () => {
    // Scenario: with the next of an array iterator, the iterator of an array or the next of a set iterator
    // answering done, buildRedactedQueryParams returns no name (the redaction of a query would be skipped), so
    // the guard must count it and a wrapped exporter must drop its batch with no send.
    const result = await runInRealProcess(CHILD, { BUNDLE: bundle.file }, 60_000)
    const report = JSON.parse(result.lines[result.lines.length - 1] ?? '{}') as {
      iteration: { label: string; params: number; counted: number; sent: number; code: number }[]
    }
    expect(report.iteration.map((r) => [r.label, r.params, r.counted > 0, r.sent, r.code])).toEqual(
      [
        ['ArrayIteratorPrototype.next', 0, true, 0, 1],
        ['Array.prototype[Symbol.iterator]', 0, true, 0, 1],
        ['SetIteratorPrototype.next', 0, true, 0, 1]
      ]
    )
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

  it('counts one, not zero, while the table of guarded built-ins cannot be read', () => {
    // Scenario: Reflect is set to null, so reading the guarded objects throws; a guard that cannot look is not
    // clean, so it counts one, and counts zero again once Reflect is back.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'Reflect') as PropertyDescriptor
    try {
      Object.defineProperty(globalThis, 'Reflect', { ...original, value: null })
      expect(pollutedNames()).toBe(1)
    } finally {
      Object.defineProperty(globalThis, 'Reflect', original)
    }
    expect(pollutedNames()).toBe(0)
  })

  it('counts a guarded built-in that was replaced and one that was deleted, and counts zero once each is back', () => {
    // Scenario: Number.isFinite replaced by another function counts one, deleted counts one, and the guard
    // counts zero again after each is restored.
    const original = Object.getOwnPropertyDescriptor(Number, 'isFinite') as PropertyDescriptor
    try {
      Object.defineProperty(Number, 'isFinite', { ...original, value: () => true })
      expect(pollutedNames()).toBe(1)
    } finally {
      Object.defineProperty(Number, 'isFinite', original)
    }
    expect(pollutedNames()).toBe(0)
    try {
      Reflect.deleteProperty(Number, 'isFinite')
      expect(pollutedNames()).toBe(1)
    } finally {
      Object.defineProperty(Number, 'isFinite', original)
    }
    expect(pollutedNames()).toBe(0)
  })
})
