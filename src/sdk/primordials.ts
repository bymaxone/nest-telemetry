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

/** `Error`, for the result of a dropped batch. */
export const ErrorClass = Error

/** The root prototype that the guard compares, as it was when this module loaded. */
export const rootPrototype = Object.prototype

/** `vm.runInNewContext`, which builds the fresh realm to compare with. */
export const runInFreshRealm = runInNewContext

/** `util.types.isPromise`, which reads the internal slot of a promise and no property of it. */
export const isPromise = types.isPromise

/** `Promise.prototype.then`, to attach a handler to a promise that the guard drops. */
export const promiseThen = Promise.prototype.then
