import type { Config } from 'jest'

/**
 * Aggregated Jest configuration for unit + E2E coverage.
 *
 * Discovers both unit specs in `src/` and E2E specs in `test/e2e/` in a single
 * Jest run, and instruments every source file under `src/` regardless of which
 * suite touched it. Lines covered exclusively by E2E tests count toward the
 * 100% threshold, and vice-versa.
 *
 * Use this for release-time validation (`pnpm test:cov:all`) and CI gates.
 * Day-to-day development should still prefer the faster `pnpm test:cov`,
 * which only runs the unit suite.
 */
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/e2e/**/*.e2e-spec.ts'],
  // This config scans the whole project (rootDir '.'), so exclude build output
  // and Stryker sandboxes: both hold copies of `src/` that share the package's
  // Haste module name, which otherwise crashes jest-haste-map with
  // "dupMap.get is not a function" on the `@bymax-one/nest-telemetry` alias.
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/.stryker-tmp/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // A unit spec opens no socket: the resolver refuses `supertest` and the setup stops `listen`, for
  // a spec under `src/` only, whatever way the spec spells it.
  resolver: '<rootDir>/scripts/jest-no-sockets.resolver.cjs',
  setupFilesAfterEnv: ['<rootDir>/scripts/jest-no-sockets.setup.cjs'],
  // Mirror the subpath aliases declared in tsconfig.json "paths" so tests and
  // production code resolve the same module instance — a dual-package hazard
  // would make `instanceof` checks return false across subpath boundaries.
  moduleNameMapper: {
    '^@bymax-one/nest-telemetry$': '<rootDir>/src/sdk/index.ts',
    '^@bymax-one/nest-telemetry/register$': '<rootDir>/src/register/index.ts',
    '^@bymax-one/nest-telemetry/nest$': '<rootDir>/src/nest/index.ts'
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.e2e.json'
      }
    ]
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/**/*.d.ts'
  ],
  coverageReporters: ['text', 'lcov', 'clover'],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    }
  },
  testTimeout: 30_000,
  clearMocks: true,
  restoreMocks: true,
  passWithNoTests: false
}

export default config
