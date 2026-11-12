---
applyTo: 'src/**/*.ts'
---

# TypeScript source code standards

## TypeScript compiler flags — practical implications

`tsconfig.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`. Review impact:

- **`noUncheckedIndexedAccess`**: `array[0]` is `T | undefined`. Every index access must be guarded.
- **`exactOptionalPropertyTypes`**: `{ prop?: string }` ≠ `{ prop: string | undefined }`. Flag conflation.
- **`noImplicitOverride`**: a member that overrides a parent must say `override`.
- **`noImplicitReturns`**: every code path must return.

## ESLint rules enforced as errors

- `no-explicit-any` — no `any` in source.
- `no-non-null-assertion` — never `!`. Narrow the type instead.
- `consistent-type-imports` — type-only imports use `import type { ... }`.
- `explicit-function-return-type` and `explicit-module-boundary-types`.
- `import/no-cycle` — circular imports are forbidden.

## Optional peers

- Every `@opentelemetry/*` package is an optional peer. Code a disabled boot reaches must not import one at module scope.
- `.` and `./register` never import `@nestjs/*`.
- Environment variables are read in one place only.

## NestJS patterns (`src/nest/` only)

- DI only — no `new ServiceClass()` outside tests.
- **Injection tokens use `Symbol()`**, never string literals, and every provider carries an explicit `@Inject(TOKEN)` because tsup drops decorator metadata.
- Lifecycle hooks (`OnApplicationShutdown`) carry `override` where they override a parent.

## Import ordering

`node:*` → external → internal (`@bymax-one/nest-telemetry`) → parent/sibling → index. Alphabetical within each group (enforced by `import/order`).

## Security

- Span data is a leak surface. Redaction of `url.query`, `url.full` and Redis command payloads is on by default and cannot be removed silently.
- Never put a token, secret or credential in a log line or an error message the library emits.

An equivalent mutant is suppressed on its own line with `// Stryker disable next-line <Mutator>: <reason>`, and the reason goes after the colon on that one line. `pnpm check:mutants` enforces the grammar. Prefer a test that kills the mutant; add a directive only when no test can.
