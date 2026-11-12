import type { Config } from 'jest'

/**
 * Jest configuration for end-to-end tests.
 *
 * Lives separately from the unit-test config (`jest.config.ts`) so that the
 * coverage thresholds enforced for the unit suite never interfere with E2E
 * runs, and so that E2E specs can be discovered under `test/e2e/` rather than
 * inside `src/`.
 */
const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/.stryker-tmp/'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // Mirror the subpath aliases declared in tsconfig.json "paths" so e2e tests
  // and production code resolve the same module instance.
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
  // Coverage is measured on `src/` and held to the same 100 on all four axes as the unit suite:
  // the e2e suite alone must exercise what it claims. With `rootDir` at the project root the
  // glob matches real files; a threshold over zero matched files would pass without measuring.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
    '!src/**/index.ts',
    '!src/**/*.d.ts'
  ],
  coverageThreshold: {
    global: { branches: 100, functions: 100, lines: 100, statements: 100 }
  },
  testTimeout: 30_000,
  clearMocks: true,
  restoreMocks: true,
  passWithNoTests: false
}

export default config
