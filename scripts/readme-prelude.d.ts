/**
 * @fileoverview The names a README snippet uses without declaring them, typed against the
 * published package. `check-published-surface.mjs` copies this file into the throwaway
 * consumer it compiles the snippets in, so a call made through one of these names is
 * checked against the real types instead of resolving to `any`.
 * @layer scripts
 *
 * Only names the surrounding prose introduces belong here. A wrong option, method or
 * field on a type the package exports is a real error and must stay one, so nothing
 * here widens a package type.
 */
declare global {
  /** What `this` holds in a snippet that shows calls without a class around them. */
  interface SnippetContext {
    readonly placeholder?: never
  }
}

export {}
