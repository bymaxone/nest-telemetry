import type { Config } from 'jest'

// Explicit `.ts` extension: Stryker loads this config in its sandbox under Node 24,
// where native-TS ESM requires the extension on relative imports (an extensionless
// './jest.config' throws ERR_MODULE_NOT_FOUND and aborts the whole mutation run).
import base from './jest.config.ts'

/**
 * Stryker-only Jest configuration.
 *
 * Wraps the base unit-test config (`jest.config.ts`) with Stryker's
 * instrumented Node test environment so that `coverageAnalysis: "perTest"`
 * can map every mutant to the exact tests that cover it. The base config is
 * left untouched (its `testEnvironment` stays the plain `'node'`) so that a
 * normal `pnpm test` never depends on the mutation-testing toolchain.
 *
 * Only used by `stryker run` through `jest.configFile` in `stryker.config.json`.
 */
const config: Config = {
  ...base,
  testEnvironment: '@stryker-mutator/jest-runner/jest-env/node'
}

export default config
