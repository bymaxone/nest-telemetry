/**
 * @fileoverview Entry of a bundle that exposes the pollution guard and the export wrap to a child process, so a
 * test can replace built-ins after the bundle loaded and watch what the guard does.
 * @layer e2e
 */
export { guardExports } from '../../../src/sdk/export-guard'
export { pollutedNames } from '../../../src/sdk/prototype-guard'
