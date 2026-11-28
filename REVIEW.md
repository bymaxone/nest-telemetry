# Review instructions

`@bymax-one/nest-telemetry` is a public npm library that wires OpenTelemetry tracing into NestJS
and plain Node. Hosts run it inside their own process, and the spans it exports leave that process.

## What Important means here

Reserve 🔴 Important for findings that would break behavior, leak data, or block a rollback:
incorrect logic, a secret reaching an exported span or a log, a telemetry failure that crashes or
blocks the host, a breaking change to a published export that the CHANGELOG does not announce.
Style, naming and refactoring suggestions are Nit at most, with the exceptions listed under
"Escalations". Report a bug with its trigger: the input or state, and the wrong result.

## Escalations

Treat these as 🔴 Important even though they look stylistic:

- A new suppression comment: `eslint-disable` in any form, `@ts-ignore`, `@ts-expect-error`,
  `@ts-nocheck`, `any`, a coverage-ignore comment, or `as unknown as <T>` hiding a real type error.
  `// Stryker disable next-line <Mutator>: <reason>` on an equivalent mutant is the documented form
  and is not one; a `Stryker disable` whose reason does not show the mutant is equivalent is.
- A change that weakens a gate: a lint rule removed or turned off, a coverage or mutation threshold
  lowered, an ignore or baseline entry added or widened, a type-check option relaxed.
- Hardcoded credentials, API keys or tokens anywhere, including test fixtures.
- A flag that skips a hook or a check, added to a script, hook or workflow.

## Cap the nits

Report at most 5 Nits per review; if there are more, say "plus N similar items" in the summary.
After the first review round on a pull request, post Important findings only. Lead the summary with
the finding count per severity.

## Do not report

- Anything CI already enforces: lint, formatting, type errors, test coverage, mutation score,
  bundle size, export-map types.
- Lockfiles, generated output (`dist/`, `coverage/`, `reports/`) and vendored code.
- Test code that breaks a production rule on purpose.
- Wording preferences. A sentence is a finding only when it is false about the code.
- A proposal to bump the major version, or to pin `bymaxone/.github` reusable workflows to a SHA.
- `shutdownTelemetry()` rejecting on a refused flush: its caller decides what that means.

## Always check

- Redaction of `url.query`, `url.full`, Redis command payloads and the exported process command
  line is on by default. Turning any of it off takes an explicitly named `unsafe` option that is
  reported at boot. A new span or resource attribute carrying host data needs the same treatment.
- A failure in the telemetry path (exporter down, flush timeout, bad environment value) never
  crashes or blocks the host application.
- `process.env` is read only in `src/sdk/environment.ts`.
- `package.json` gains no entry under `dependencies`; a runtime requirement is a peer dependency,
  and every `@opentelemetry/*` package is an optional one.
- A class or injection token used by two subpaths is not copied into both bundles by a relative
  import: the two copies are different tokens.
- Providers use `Symbol()` tokens with an explicit `@Inject(TOKEN)`.
- Everything published is English, `docs/` included, and carries no AI attribution.
- Comments state what holds now: no history, phase, task or review-round references.
- A claim about a dependency's behavior cites what was read, not an inference from a name.
