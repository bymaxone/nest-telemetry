---
applyTo: '**/*.spec.ts,**/*.e2e-spec.ts'
---

# Testing standards

## Coverage gate

`pnpm test:cov:all` enforces **100% statements, branches, functions, and lines** over the unit and e2e suites together, and `pnpm test:e2e` holds the e2e suite alone to the same 100. Nothing is excluded and `passWithNoTests` is off. Any PR that drops coverage on a touched source file must not be approved.

## Mutation testing threshold

Break gate: **100%** (`thresholds.break: 100`), with the mutation inventory gate in `enforce` mode. A mutant no test can kill carries a `// Stryker disable next-line <Mutator>: <reason>` on its line, validated by `pnpm check:mutants`. Flag tests that use generic matchers (`toBeDefined()`, `toBeTruthy()`) where a value assertion is possible — they survive mutants.

## Test structure

Every `it()` carries a comment stating the scenario it covers, and a name that states the expected behaviour. Avoid `it('works')`.

## Unit and e2e split

A unit spec (`src/**/*.spec.ts`) opens no socket, starts no server and spawns no process; `pnpm check:socket-gate` enforces the first two. A case that needs a local OTLP receiver or a child process (`node --import`) belongs in `test/e2e/` (`*.e2e-spec.ts`).

## Scope: public API only

Test through exported interfaces. Never reach private members or unexported internals; if behaviour is only verifiable through one, the design needs refactoring.

## Mutation-aware assertions

1. Assert the value, not existence: `expect(result.level).toBe('info')`, not `toBeDefined()`.
2. Test both sides of every `||` / `&&`: a test with only one operand true kills the `&&` → `||` mutant.
3. Assert each field and each message independently.

## Optional peers

Test both the "peer present" and the "peer absent" path of every feature that touches an `@opentelemetry/*` package. Restore mocks in `afterEach` so nothing bleeds across files.
