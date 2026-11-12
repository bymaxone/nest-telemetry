/**
 * @fileoverview Scaffold placeholder. It exists so every gate (coverage, mutation, size,
 * packaging) runs end to end on a real module, and it carries no behaviour.
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
