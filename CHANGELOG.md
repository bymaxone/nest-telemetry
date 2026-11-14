# Changelog

All notable changes to `@bymax-one/nest-telemetry` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The `release.yml` workflow extracts the section matching the pushed `vX.Y.Z` tag
as the GitHub Release body, so each released version needs a matching `## [X.Y.Z]`
heading here.

## [1.0.3] - 2026-11-14

### Added

- **`shutdownTimeoutMs`** on `TelemetryOptions`: the longest `shutdown()` and `shutdownTelemetry()` wait for the
  final flush, in milliseconds. It defaults to 5000. A value that is not a finite number above zero, or is above
  120000, means the default. When the flush has not finished by then, shutdown emits
  `BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT` and resolves; the flush keeps running in the background and a failure after
  the deadline is dropped. Spans still queued at that point may be lost.
- `BYMAX_TELEMETRY_EXPORT_FAILED`: a span export failed, so the batch was dropped. The warning names the
  exporter and a short upper-case error code (`UNKNOWN` when there is none), never the payload, the endpoint or
  the error message, and repeats at most once a minute. Before, a collector that was down left the application
  silent.
- A **Production** section in the README with measured, scoped figures for sampling, TLS to the collector, a
  collector that is down, CPU, memory and the optional `--max-semi-space-size` lever. "What This Library Does
  NOT Do" says that log records forwarded through `OTEL_LOGS_EXPORTER` are not redacted by this library.

### Changed

- **`ignorePaths` never ignores a path longer than 2,048 characters**, and the patterns are not run against it,
  so the request keeps its span. Before, the patterns ran against a path of any length. The query is cut first,
  so only the path counts. The cap does not bound a pattern with nested quantifiers on a short path, so anchor
  patterns with no nested quantifiers.
- **A down collector now ends shutdown at the deadline with a warning, where it used to reject.** Against a
  closed port, shutdown took 7 seconds before this release and rejected with the connection error. The
  exporter's retries outlast the 5-second default, so shutdown now resolves with
  `BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT`.

### Apply to a derived backend

The new option is the only change to the declarations; a derived backend acts on these behaviours:

1. A caller that branches on the rejection of `shutdown()` or `shutdownTelemetry()` to detect a collector that
   is down now has to read the `BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT` and `BYMAX_TELEMETRY_EXPORT_FAILED`
   warnings instead, or set `shutdownTimeoutMs` above the time the exporter needs to give up. Measured against a
   closed port, a deadline of 5000 ms resolved at 5002 ms with the warning, and a deadline of 20000 ms rejected
   with the connection error after 7.8 s. A collector that accepts a connection and never answers took 10
   seconds, the exporter's own timeout.
2. Set `shutdownTimeoutMs` to fit the termination grace period of the platform: a shutdown that waits longer
   than the grace period is killed before it finishes.
3. A route that `ignorePaths` was ignoring with a path over 2,048 characters now produces a span. Anchor the
   patterns, with no nested quantifiers.

## [1.0.2] - 2026-11-13

### Security

- **node-redis command arguments and keys no longer reach `db.query.text`.** The command-name serializer
  was applied to `instrumentation-ioredis` only, so `instrumentation-redis` kept the default one: an
  `EVAL` argument and a key were exported on node-redis 3.1.2, 4.7.1, 5.12.2 and 6.3.1. Both
  instrumentations now export the command name only, behind the same
  `unsafe.disableRedisArgumentRedaction`, and a host override cannot replace the serializer of either.

### Fixed

- `OTEL_SDK_DISABLED` is read as the SDK reads it, trimmed. A value such as `"true "` or `" TRUE"`
  made the library load the loader hook and every OpenTelemetry package and report `enabled: true`,
  while the SDK itself did nothing.
- A later `startTelemetry` call against a running SDK no longer drops its options silently: see the
  warning below.

### Added

- `BYMAX_TELEMETRY_OPTIONS_IGNORED`: a `startTelemetry` call reached an SDK that was already running, so its
  options were ignored, or `enabled: false` did not stop it. Any defined option counts, `env` included, and a
  call that passes none stays silent.
- `BYMAX_TELEMETRY_RESTART_UNSUPPORTED`: see below.

### Changed

- **A start after a shutdown in the same process is refused.** `startTelemetry` rejects with an error that
  says to start once per process, and once in a global setup for a test suite, and the process emits
  `BYMAX_TELEMETRY_RESTART_UNSUPPORTED`; the preload turns it into its start-failed warning. Auto-instrumented
  spans can never resume after a shutdown in the same process, because the modules are already patched;
  spans created through the API could, but a half-working restart is refused on purpose. Before, the second
  start reported `enabled: true` and exported nothing. A test suite that started one SDK per case now has to
  start once.
- The README names both Redis clients, says which one needs an active span, states what was measured about
  mysql2 bound values, and lists the identifiers the library does not redact. A canary in the runtime proofs
  fails if a bound mysql2 value ever reaches `db.query.text`.

### Shutdown order of `TelemetryModule`

`TelemetryModule` is now global, so its shutdown hook runs among the last. A span that another global module
ends in its own shutdown hook, such as a queue drain, is now exported when `TelemetryModule` is listed first in
the application module's imports, and was dropped before. Nest closes global modules in the reverse of the
order it registers them, so list it before any module that is global or imports a global module. Applications
that provided `TelemetryShutdownHook` in a module of their own to get this order can import the module.

### Apply to a derived backend

The declarations did not change; four behaviours did, and a derived backend acts on them:

1. A start after a shutdown in the same process now throws. Start telemetry once per process, and in a
   test suite start it once in a global setup.
2. `TelemetryModule` is global. List it **first** in the application module's imports, so its flush runs
   last; a module of your own that only provided `TelemetryShutdownHook` to get that order can import it.
3. `OTEL_SDK_DISABLED` is trimmed as the SDK trims it, so a padded `" true "` now really disables.
4. node-redis spans now carry the command name only. A dashboard or alert that matched node-redis
   arguments or keys in `db.query.text` has to change.

## [1.0.1] - 2026-11-12

Documentation only; the built files are the same as in 1.0.0.

### Changed

- The changelog dates 1.0.0, which the published package still lists as unreleased.
- The README follows the structure of the other `@bymax-one` libraries. Its claims are those of 1.0.0,
  and a `service.name` set only in `OTEL_RESOURCE_ATTRIBUTES` reaches the spans while the `env`
  or `service` resource detector is enabled, and the missing-service-name warning still fires.
- `docs/mutation_testing_results.md` records the cold mutation run that gated 1.0.0.

## [1.0.0] - 2026-11-12

First release.

### Added

- **`.`**: `startTelemetry(options)` assembles the OpenTelemetry SDK from the host's options and the
  standard `OTEL_*` variables and returns a handle; `shutdownTelemetry()` drains it; `ignorePaths(patterns)`
  builds the incoming-request predicate; `DEFAULT_REDACTED_QUERY_PARAMS`. The SDK part imports no
  `@nestjs/*` package.
- **`./register`**: a zero-config preload for `node --import`. It registers the OpenTelemetry loader
  hook so native ES modules are instrumented, starts the SDK from the standard variables and flushes on
  a natural exit. A failed start or hook is a warning, never a failed boot. Its CommonJS entry refuses to
  load and names `node --import`.
- **`./nest`**: `TelemetryModule` and `TelemetryShutdownHook` flush the SDK when the application closes.
  A failed flush never rejects and is reported under the stable key `TRACING_FLUSH_FAILED`, through the
  structured logger bound to `TELEMETRY_LOGGER` or the Nest logger.
- **Redaction on by default**: `url.query`, `url.full`, `http.url` and `http.target` on every span; a
  credential-parameter list for outgoing request URLs that a host can add to and not replace; Redis
  command arguments, `EVAL` payloads included; the process command line in the exported resource. Each
  of the others has an explicit `unsafe` off switch that emits a `SecurityWarning`; the credential-parameter list has none. `instrumentations.overrides`
  cannot undo a layer.
- **Zero cost when disabled**: a boot with `OTEL_SDK_DISABLED=true` registers no hook and loads no
  OpenTelemetry package, `@opentelemetry/api` included.
- One module reads the environment. `OTEL_SERVICE_NAME` overrides the `serviceName` option, and
  `OTEL_SDK_DISABLED=true` always disables.
- Warnings with stable codes: `BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED`,
  `BYMAX_TELEMETRY_SERVICE_NAME_MISSING`, `BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE`,
  `BYMAX_TELEMETRY_START_FAILED`.
- Optional peers: `@opentelemetry/api`, `sdk-node`, `sdk-trace`, `resources`, `exporter-trace-otlp-http`,
  `auto-instrumentations-node`, `instrumentation`, and `@nestjs/common`, `@nestjs/core`,
  `reflect-metadata`, `rxjs` for `./nest`.
- Verification from the packed tarball: real `node --import` processes in a CommonJS and a native-ESM
  application, with planted secrets absent from the exported body and negative controls.

[1.0.3]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.3
[1.0.2]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.2
[1.0.1]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.1
[1.0.0]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.0
