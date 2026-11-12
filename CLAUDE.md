# @bymax-one/nest-telemetry — AI Agent Quick Reference

> **Type:** npm public library (NOT an application)
> **Package:** `@bymax-one/nest-telemetry` — OpenTelemetry tracing for NestJS 11, with an SDK part usable from plain Node
> **Runtime:** Node.js 24+ | Zero direct dependencies (functionality via optional peer deps)

---

## Critical Rules

**1. npm Library — Not an App** (uses pnpm)

- Zero direct dependencies (`"dependencies": {}`). Everything is a `peerDependency` or a `node:` builtin.
- Every `@opentelemetry/*` package is an OPTIONAL peer. A disabled boot loads none of them.
- Export the public API from `src/{subpath}/index.ts`. Use `export type` for types, `export` for values.

**2. English Only**

- All code, comments, JSDoc, names and docs outside `docs/` in English. JSDoc on every public export.
- **Everything that reaches GitHub is English too**: commit messages, branch names, pull request titles and bodies, review comments and replies, issues, labels and release notes.
- Found something already published in another language? Rewrite it in place. Rewriting a pushed commit message needs a force-push, so ask first.

**3. TypeScript — Zero `any`**

- Never `any`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable` or a coverage-ignore comment. Use `unknown`, generics or explicit types.
- `strict: true` — no exceptions.

**4. Security — Non-Negotiable**

- Span data is a leak surface: `url.query`, `url.full` and Redis command payloads are redacted by default, and redaction cannot be disabled silently.
- Environment variables are read in ONE documented place; nowhere else touches `process.env`.
- A failure in the telemetry path never crashes or blocks the host application.

**5. NestJS Patterns**

- Injection tokens: `Symbol()` — never strings.
- `@Inject(TOKEN)` explicit on every provider (tsup strips decorator metadata).
- The SDK entry (`.`) and `./register` import no `@nestjs/*` package; only `./nest` does.

**6. Code Style**

- Single quotes, no semicolons, 2-space indent. camelCase files, PascalCase classes.
- Import order: `node:` → external → internal → relative → types. One concern per file.

**7. Testing — TDD, 100% Coverage (hard gate)**

- Co-located unit tests (`*.spec.ts`), end-to-end tests in `test/e2e/` (`*.e2e-spec.ts`). A scenario comment on every `it()`.
- **100% statements / branches / functions / lines** in the unit suite, in the e2e suite and in both together; `passWithNoTests` is off; nothing is excluded. Stryker runs at 100.

**8. Build** — tsup → ESM (.mjs) + CJS (.cjs) + .d.ts/.d.cts per subpath. `sideEffects: false` except where a subpath is a preload. Peer deps always external.

---

## Verification — Run Before Completing Any Task

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Before a release: `pnpm test:cov:all`, `pnpm mutation`, `pnpm check:published`, `pnpm check:exports`,
`pnpm check:runtime`, `pnpm size`.

Equivalent mutants are documented **in the source** as
`// Stryker disable next-line <Mutator>: <reason>`; `pnpm check:mutants` enforces the grammar.
---

## Documentation changes ship

`README.md` and `CHANGELOG.md` are in `files`, so they are part of the published package. A change to
either goes out as a patch release: bump the version and add the CHANGELOG section in the same pull
request, and verify that `dist/` is unchanged instead of asserting it.

The first publish (1.0.0) and every version bump need the maintainer's explicit instruction naming the
number. Never infer a bump from an event.

For full architecture and patterns, see **[AGENTS.md](./AGENTS.md)** (load on demand — not every session).
