/**
 * @fileoverview Entry of a bundle that exposes the pollution guard and the export wrap to a child process, so a
 * test can replace built-ins after the bundle loaded and watch what the guard does.
 * @layer e2e
 */
export { guardExports } from '../../../src/sdk/export-guard'
export { GUARDED_BUILTINS, pollutedNames } from '../../../src/sdk/prototype-guard'
export { exportFailureCount, warnOnExportFailure } from '../../../src/sdk/export-failure'
export { settleOptions } from '../../../src/sdk/settle-options'
export { clearWarningSink, registerWarningSink } from '../../../src/sdk/warning-sink'
export { describeFailure } from '../../../src/sdk/error-code'
export { buildRedactedQueryParams } from '../../../src/sdk/redaction'
