/**
 * Jest configuration for `scripts/mutate-const-tables.mjs`: `jest.config.ts` with the type check of
 * ts-jest turned off. A removed property that other code reads would fail the type check and count
 * as killed, which Stryker would not, so only a failed assertion may kill a mutant. Keep the
 * module mapping in step with `jest.config.ts`.
 *
 * Layer: repository tooling.
 */
import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: 'src',
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  // A unit spec opens no socket: the resolver refuses `supertest` and the setup stops `listen`, for
  // a spec under `src/` only, whatever way the spec spells it.
  resolver: '<rootDir>/../scripts/jest-no-sockets.resolver.cjs',
  setupFilesAfterEnv: ['<rootDir>/../scripts/jest-no-sockets.setup.cjs'],
  moduleNameMapper: {
    '^@bymax-one/nest-telemetry$': '<rootDir>/sdk/index.ts',
    '^@bymax-one/nest-telemetry/register$': '<rootDir>/register/index.ts',
    '^@bymax-one/nest-telemetry/nest$': '<rootDir>/nest/index.ts'
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.jest.json', diagnostics: false }]
  },
  clearMocks: true,
  restoreMocks: true
}

export default config
