# nest-telemetry — Repository Instructions

`@bymax-one/nest-telemetry` is a public npm library that wires OpenTelemetry tracing into NestJS 11 and plain Node: it starts the SDK before the application loads, redacts secrets from spans by default, and flushes on shutdown. Runtime: Node 24+. Package manager: pnpm.

## Commands

```bash
pnpm install          # install dev dependencies
pnpm typecheck        # tsc --noEmit over src, the build config and the e2e config
pnpm lint             # ESLint on src, scripts and test
pnpm test             # Jest unit tests
pnpm test:e2e         # Jest e2e tests, with coverage held at 100
pnpm test:cov:all     # unit and e2e together — 100% gate (pre-publish enforced)
pnpm mutation         # Stryker mutation tests — break: 100
pnpm build            # clean + tsup → dist/ (ESM + CJS + .d.ts for every subpath)
pnpm size             # brotli bundle-size budget per subpath
pnpm check:runtime    # loads the packed tarball in ESM and CJS under dependency denials
```

## Source layout

```
src/
  sdk/        →  exported as "."           (programmatic start; imports no @nestjs/*)
  register/   →  exported as "./register"  (zero-config preload for `node --import`)
  nest/       →  exported as "./nest"      (NestJS module and shutdown flush)
```

## Non-negotiable rules

1. **`package.json → "dependencies"` must remain empty** — every runtime requirement is an optional peer dependency.
2. **Every `@opentelemetry/*` package is an optional peer, and a disabled boot loads none of them.** Load them lazily, never at module scope in code a disabled boot reaches.
3. **`.` and `./register` import no `@nestjs/*` package.**
4. **Environment variables are read in one documented place.** No other module touches `process.env`.
5. **Redaction is on by default and cannot be disabled silently** — turning it off takes an explicitly named option and logs a warning at boot.
6. **JSDoc on every export.**
7. **Conventional Commits** — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`. PR titles and commit messages must comply.
