/**
 * @fileoverview Scaffold placeholder. It exists so every gate (coverage, mutation, size,
 * packaging) runs end to end on a real module before the library code lands, and it is
 * removed together with its specs in the first feature pull request.
 * @layer sdk
 */

/**
 * Identifies the package in the scaffold build.
 *
 * @returns The package name, without its scope.
 */
export function scaffoldMarker(): string {
  return 'nest-telemetry'
}
