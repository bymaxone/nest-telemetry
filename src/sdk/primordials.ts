/**
 * @fileoverview The built-ins that the pollution guard and the export wrap call, read once when this module
 * loads, so a built-in that something replaces afterwards cannot blind the check that refuses to export.
 * @layer sdk
 *
 * Whatever code runs in the process after the library loaded can assign over `Object.getOwnPropertyDescriptors`,
 * `Object.hasOwn` or a method of `Set.prototype`; a guard that looked them up when it ran would then count
 * nothing. Everything the guard and the wrap use is read here, and they use no method of a prototype, no
 * iterator and no collection: the guard walks arrays by index and keeps its names on an object with no prototype.
 */
import { types } from 'node:util'
import { runInNewContext } from 'node:vm'

/** `Object.create`. */
export const create = Object.create

/** `Object.defineProperty`. */
export const defineProperty = Object.defineProperty

/** `Object.getOwnPropertyDescriptor`. */
export const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor

/** `Object.getOwnPropertyDescriptors`. */
export const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors

/** `Object.getPrototypeOf`. */
export const getPrototypeOf = Object.getPrototypeOf

/** `Object.hasOwn`. */
export const hasOwn = Object.hasOwn

/** `Reflect.ownKeys`. */
export const ownKeys = Reflect.ownKeys

/** `Reflect.apply`. */
export const apply = Reflect.apply

/** `Object.entries`. */
export const entries = Object.entries

/** `Object.keys`. */
export const keys = Object.keys

/** `Array.isArray`. */
export const isArray = Array.isArray

/** `Number.isInteger`. */
export const isInteger = Number.isInteger

/** `Reflect.get`. */
export const reflectGet = Reflect.get

/** `Reflect.set`. */
export const reflectSet = Reflect.set

/** `Reflect.deleteProperty`. */
export const reflectDelete = Reflect.deleteProperty

/** `util.types.isProxy`. */
export const isProxy = types.isProxy

/** `util.types.isRegExp`. */
export const isRegExp = types.isRegExp

/** `Error`, for the result of a dropped batch. */
export const ErrorClass = Error

/** The root prototype that the guard compares, as it was when this module loaded. */
export const rootPrototype = Object.prototype

/** `vm.runInNewContext`, which builds the fresh realm to compare with. */
export const runInFreshRealm = runInNewContext

/** `util.types.isPromise`, which reads the internal slot of a promise and no property of it. */
export const isPromise = types.isPromise

/**
 * The value of an own data property, and `undefined` for an accessor or a missing property. A descriptor is an ordinary
 * object: `descriptor.value` on an accessor's would resolve through a `value` planted on the root prototype, so the
 * field is read only when the descriptor owns it.
 *
 * @param holder - The object.
 * @param key - The property.
 * @returns The value of the data property.
 */
export function dataValue(holder: object, key: PropertyKey): unknown {
  const descriptor = getOwnPropertyDescriptor(holder, key)
  return descriptor !== undefined && hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

/** A promise the engine built from its own intrinsic, whatever `globalThis.Promise` is: where the intrinsic is read from. */
const engineSample = (async (): Promise<undefined> => undefined)()

/**
 * `Promise.prototype` as the engine holds it, read from a promise an `async` function built, and not from the
 * `Promise` global: a host that replaced the global before this module loaded changes neither. Its `constructor` is
 * what a `then` reads for a species, and the guard requires it to be untouched.
 */
export const promisePrototype = getPrototypeOf(engineSample) as Promise<unknown>

/**
 * The `Promise` constructor that {@link promisePrototype} holds, to build the promises the guard settles itself. It is
 * read as the data property of the engine's prototype, so a getter there never runs. A value planted there before
 * this module loaded is captured too, and the guard refuses a constructor that is not the engine's: see
 * `promiseConstructorChanged`. A slot that is gone or is an accessor falls back to the `Promise` of a fresh realm, never to the global one, which a
 * host may have replaced; a start can then still be built and refused rather than throw at its caller, and the
 * guard counts that slot as changed.
 */
export const NativePromise = (dataValue(promisePrototype, 'constructor') ??
  runInFreshRealm('Promise')) as PromiseConstructor

/**
 * The `then` that {@link promisePrototype} holds, read as a data property when this module loaded. Called on a promise
 * through `Reflect.apply`, it attaches a reaction to that promise without reading a `then` from it, so a `then` that
 * something installs on `Promise.prototype` later is never the one that runs; the guard compares the slot with a
 * fresh realm's, so a `then` planted before the load is counted.
 */
export const promiseThen = dataValue(promisePrototype, 'then') as Promise<unknown>['then']

/** `Object.freeze`, so a handle handed to the host cannot be given a `then` or a replaced `shutdown`. */
export const freeze = Object.freeze

/** `Array.prototype`, whose `then` the guard requires to be absent. */
export const arrayPrototype = Array.prototype

/** `Function.prototype`, whose `then` the guard requires to be absent. */
export const functionPrototype = Function.prototype

/** `String.prototype.endsWith`, called through {@link apply}. */
export const endsWith = String.prototype.endsWith

/** `Object`, which turns any value into an object. */
export const toObject = Object

/** `String`, which turns a value into its text. */
export const toText = String

/** `RegExp.prototype.exec`, called through {@link apply}: `test` looks `exec` up again when it runs. */
export const regExpExec = RegExp.prototype.exec

/** `Number`, which turns a value into a number. */
export const toNumber = Number

/** `performance.now`, called through {@link apply} on {@link clockOwner}. */
export const clockNow = performance.now

/** The `performance` object that {@link clockNow} belongs to, as it was when this module loaded. */
export const clockOwner = performance
