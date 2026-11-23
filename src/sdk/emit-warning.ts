/**
 * @fileoverview The one place that hands a warning to `process.emitWarning`, with options that own the names
 * Node reads from them, so a name planted on `Object.prototype` is never printed and never read from the options.
 * @layer sdk
 */

/** The type and code of a warning. */
export interface WarningKind {
  /** The warning type, such as `Warning` or `SecurityWarning`. */
  readonly type: string
  /** The stable code. */
  readonly code: string
}

/**
 * Emits a process warning. Node reads `detail` and `ctor` from the options object and assigns a string `detail`
 * onto the warning, which prints it: with no `detail` of its own, the warning inherits a planted one and prints
 * it, and a read-only one makes the assignment throw. The options therefore carry an own, empty `detail`, which
 * the warning owns in turn, and an own `ctor` that is undefined. A warning that cannot be emitted is dropped.
 *
 * @param text - The warning text.
 * @param kind - Its type and code.
 */
export function emitWarning(text: string, kind: WarningKind): void {
  try {
    process.emitWarning(text, {
      type: kind.type,
      code: kind.code,
      detail: '',
      ctor: undefined
    })
  } catch {
    // A read-only name on the root prototype makes Node's assignment onto the warning throw; a warning that
    // cannot be built must not become an exception in the host's own code path.
  }
}
