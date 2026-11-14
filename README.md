<p align="center">
  <img src="https://img.shields.io/badge/%40bymax--one-nest--telemetry-000000?style=for-the-badge&logo=opentelemetry&logoColor=F5A800" alt="@bymax-one/nest-telemetry" />
</p>

<h1 align="center">@bymax-one/nest-telemetry</h1>

<p align="center">
  <strong>OpenTelemetry tracing for NestJS 11 and plain Node</strong><br />
  <sub>Preload · Span Redaction · Native ESM · Graceful Flush · Zero Runtime Dependencies</sub>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@bymax-one/nest-telemetry"><img src="https://img.shields.io/npm/v/@bymax-one/nest-telemetry?style=flat-square&colorA=000000&colorB=000000" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/@bymax-one/nest-telemetry"><img src="https://img.shields.io/npm/dm/@bymax-one/nest-telemetry?style=flat-square&colorA=000000&colorB=000000" alt="npm downloads" /></a>
  <a href="https://github.com/bymaxone/nest-telemetry/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/bymaxone/nest-telemetry/ci.yml?branch=main&style=flat-square&colorA=000000&label=CI" alt="CI status" /></a>
  <a href="https://github.com/bymaxone/nest-telemetry/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/coverage-100%25-brightgreen?style=flat-square&colorA=000000" alt="coverage" /></a>
  <a href="https://github.com/bymaxone/nest-telemetry/blob/main/docs/mutation_testing_results.md"><img src="https://img.shields.io/badge/mutation-100%25-brightgreen?style=flat-square&colorA=000000" alt="mutation score" /></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/bymaxone/nest-telemetry"><img src="https://api.scorecard.dev/projects/github.com/bymaxone/nest-telemetry/badge?style=flat-square" alt="OpenSSF Scorecard" /></a>
  <a href="https://github.com/bymaxone/nest-telemetry/blob/main/LICENSE"><img src="https://img.shields.io/github/license/bymaxone/nest-telemetry?style=flat-square&colorA=000000&colorB=000000" alt="license" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-24%2B-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" /></a>
</p>

<p align="center">
  <a href="https://github.com/bymaxone/nest-telemetry">GitHub</a> ·
  <a href="https://github.com/bymaxone/nest-telemetry/issues">Issues</a> ·
  <a href="#-quick-start">Quick Start</a> ·
  <a href="#-api-reference">API Reference</a>
</p>

---

## ✨ Overview

`@bymax-one/nest-telemetry` starts the OpenTelemetry SDK before your application loads, redacts secrets from spans by default (URL query strings, Redis arguments, the process command line), keeps probe paths out of your traces and flushes on shutdown. It ships as a single npm package with **subpath exports**: an SDK part that works from plain Node, a `node --import` preload, and a NestJS module.

Every `@opentelemetry/*` package is an **optional peer dependency**, and a boot with telemetry disabled loads none of them. The library is the mechanism; the host application keeps the policy: whether tracing is on, which paths are probes, what the service is called.

### Support matrix

| Part                     | Supported                                                     |
| ------------------------ | ------------------------------------------------------------- |
| Node.js                  | 24 or newer                                                   |
| NestJS (`./nest` only)   | 11                                                            |
| Applications             | CommonJS and native ES modules                                |
| OpenTelemetry generation | The one in [OpenTelemetry Versions](#-opentelemetry-versions) |

**Native ES modules.** Auto-instrumentation patches CommonJS modules as they load, and native ES modules only through a loader hook. The preload registers that hook, and it needs the optional peer `@opentelemetry/instrumentation`. Without that package, a native-ESM application gets no auto-instrumentation at all; CommonJS code is unaffected, and the start warns (`BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE`) so the gap is not silent. Measured on real consumers: an ESM application with the SDK started and no hook exported no HTTP span; with the hook it did.

### Why nest-telemetry?

- **💤 Zero cost when disabled** — A boot with `OTEL_SDK_DISABLED=true` registers no loader hook and loads no OpenTelemetry package, `@opentelemetry/api` included; this is checked from the packed tarball in ESM and CommonJS, with a positive control that proves the check can fail.
- **🔒 Secret-safe by default** — Span data is a leak surface, so URL query strings, Redis arguments and the process command line are redacted unless an explicit option, which also warns, turns one off. No environment variable does.
- **🚦 Preload ordering done right** — The SDK has to start before the libraries it instruments load, and `main.ts` is too late; a `node --import` preload runs first and reads only the standard `OTEL_*` variables.
- **🔌 Your policy, your rules** — Enabling, probe paths, service name and version, extra redacted parameters and the structured logger are passed in.

Install it with the OpenTelemetry peers you use: the command is in [Quick Start](#-quick-start).

---

## 🔥 Features

### 🚦 Boot and lifecycle

- ✅ **`node --import` preload** — Registers the ES-module loader hook, starts the SDK from the standard variables and flushes on a natural exit
- ✅ **One SDK per process** — The handle lives under a `Symbol.for` key on `globalThis`, so an ES-module preload and a CommonJS application share it, and a second start returns the one already running
- ✅ **Graceful Nest shutdown** — `TelemetryModule` awaits the flush as part of the application's own shutdown, under the stable failure key `TRACING_FLUSH_FAILED`
- ✅ **Never takes the host down** — Each failure the preload can meet is a warning and the application still starts; a flush the collector refuses is reported by the Nest module, never thrown into your shutdown path

### 🔐 Redaction

- ✅ **Span-end query redaction** — `url.query` is replaced and the query is cut from `url.full`, `http.url` and `http.target`, on spans from any instrumentation
- ✅ **Outgoing-URL credential list** — A list of credential-bearing parameters, checked in a test against the SDK's own default list; a host can add names and never drop them
- ✅ **Redis commands reduced to their name** — for `ioredis` and node-redis (`redis`), arguments and keys never leave the process, `EVAL` and `EVALSHA` payloads included
- ✅ **Command line kept out of the resource** — `process.command_args` and `process.command_line` are dropped
- ✅ **Explicit, loud opt-outs** — Each off switch is a literal `unsafe.*: true` and emits a `SecurityWarning`

---

## 📦 Subpath Exports

One package, separate entry points. Import only what your app needs:

| Subpath      | Import                               | Purpose                                                                                                                      |    Dependencies     |
| ------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | :-----------------: |
| **SDK**      | `@bymax-one/nest-telemetry`          | `startTelemetry`, `shutdownTelemetry`, `ignorePaths`, `DEFAULT_REDACTED_QUERY_PARAMS`, types                                 | OpenTelemetry peers |
| **Register** | `@bymax-one/nest-telemetry/register` | The preload for `node --import`; importing it runs it, and it exports nothing                                                | OpenTelemetry peers |
| **Nest**     | `@bymax-one/nest-telemetry/nest`     | `TelemetryModule`, `TelemetryShutdownHook`, `TELEMETRY_LOGGER`, `TELEMETRY_FLUSH_FAILED_KEY`, `ITelemetryErrorLogger` (type) |      NestJS 11      |

The SDK entry and `./register` import no `@nestjs/*` package; only `./nest` does. Requiring `./register` from CommonJS throws and names `node --import`.

---

## 🚀 Quick Start

### NestJS

Install the package and the OpenTelemetry peers you use:

```sh
pnpm add @bymax-one/nest-telemetry \
  @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/sdk-trace @opentelemetry/resources \
  @opentelemetry/exporter-trace-otlp-http @opentelemetry/auto-instrumentations-node \
  @opentelemetry/instrumentation
```

Name your service and point the exporter at a collector, using standard variables:

```sh
export OTEL_SERVICE_NAME=billing
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

Start the application with the preload:

```sh
node --import @bymax-one/nest-telemetry/register dist/main.js
```

Import the module, so Nest flushes the SDK when the application closes, and enable Nest's shutdown hooks so a signal runs them:

```ts
import { Module } from '@nestjs/common'

import { TelemetryModule } from '@bymax-one/nest-telemetry/nest'

@Module({ imports: [TelemetryModule] })
export class AppModule {}
```

`TelemetryModule` is global, and Nest closes global modules last, in the reverse of the order it registers them. List it **first** in the application module's imports, before any module that is global or that imports a global module, so it closes after them: a span that another global module, such as a queue drain or a database module, ends in its own shutdown hook is exported only if `TelemetryModule` was registered first. Measured with Nest 11: listed first, the span arrives whether the other global module is imported directly or through a feature module; listed after a feature module that imports a global module, or after the global module itself, the span is dropped.

Things to know before you rely on it:

1. **Traces only, by default.** Metrics and logs stay off unless `OTEL_METRICS_EXPORTER` or `OTEL_LOGS_EXPORTER` names an exporter. This departs from the OpenTelemetry default, which exports both through OTLP, and it does so on purpose: otherwise a host that already ships metrics and logs another way would send them twice.
2. **Name your service.** With neither `OTEL_SERVICE_NAME` nor a `serviceName` option, the start warns once (`BYMAX_TELEMETRY_SERVICE_NAME_MISSING`) and spans are exported as `unknown_service:node`, which groups unrelated services under one name. A `service.name` set only in `OTEL_RESOURCE_ATTRIBUTES` is honoured and the spans carry it while the `env` or `service` resource detector is enabled, as every detector is by default, but the warning still fires, because the library looks only at `OTEL_SERVICE_NAME` and the option; set `OTEL_SERVICE_NAME` to silence it. The start is never refused.
3. **Signals.** The preload flushes when the process runs out of work. It installs no signal handler, because a handler in the preload would race the application's own shutdown. In Nest, call `app.enableShutdownHooks()` so `SIGTERM` closes the application, and the module flushes the SDK. In plain Node, call `shutdownTelemetry()` yourself.

### Plain Node

The SDK part never imports `@nestjs/*`. Start it from your own preload, or from the first lines of your entry point if nothing instrumented has been imported yet:

```ts
import { ignorePaths, startTelemetry } from '@bymax-one/nest-telemetry'

const telemetry = await startTelemetry({
  serviceName: 'billing',
  serviceVersion: '1.4.2',
  ignoreIncomingRequest: ignorePaths([/^\/health\/(live|ready)\/?$/, /^\/metrics\/?$/])
})

// ... run your application ...

// In your own graceful-shutdown path, after your resources are closed:
await telemetry.shutdown()
```

This package installs no signal handler and shows none, because handling signals belongs to the application: a `SIGTERM` listener replaces Node's default termination, so it has to end the process itself once its work is done. `startTelemetry` resolves to a handle with `enabled` and `shutdown()`. Starting twice returns the handle already running, including across two copies of the module (an ES-module preload and a CommonJS application share the handle through `globalThis`). A later call that passes options is told they were ignored, and `enabled: false` against a running SDK is told it does not stop it: `shutdownTelemetry()` does.

---

## ⚙️ Configuration

### `startTelemetry(options)`

Every field is the host's policy, and none is required.

| Option                                 | Default                      | What it does                                                                                                                                                                   |
| -------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enabled`                              | `true`                       | `false` never starts the SDK. `OTEL_SDK_DISABLED=true` disables it regardless.                                                                                                 |
| `serviceName`                          | `unknown_service:node`       | The service name. `OTEL_SERVICE_NAME` overrides it.                                                                                                                            |
| `serviceVersion`                       | none                         | The service version.                                                                                                                                                           |
| `ignoreIncomingRequest`                | none                         | Returns `true` for an incoming request that must produce no server span. `ignorePaths(patterns)` builds one from anchored patterns.                                            |
| `instrumentations.fs`                  | `false`                      | File-system instrumentation.                                                                                                                                                   |
| `instrumentations.sendLogs`            | follows `OTEL_LOGS_EXPORTER` | Whether pino's records are forwarded to the OpenTelemetry logs pipeline.                                                                                                       |
| `instrumentations.overrides`           | none                         | Per-instrumentation configuration, merged over the library's. Redaction settings cannot be replaced here.                                                                      |
| `extraRedactedQueryParams`             | none                         | Names added to the list redacted from outgoing request URLs. They add to the defaults and never replace them.                                                                  |
| `unsafe.disableUrlRedaction`           | off                          | Keeps `url.query`, `url.full`, `http.url` and `http.target` as recorded. Literal `true`. Warns.                                                                                |
| `unsafe.disableRedisArgumentRedaction` | off                          | Keeps Redis command arguments in `db.query.text`. Literal `true`. Warns.                                                                                                       |
| `unsafe.exportProcessCommandArgs`      | off                          | Keeps `process.command_args` and `process.command_line` in the resource. Literal `true`. Warns.                                                                                |
| `shutdownTimeoutMs`                    | `5000`                       | The longest shutdown waits for the final flush. Past it, shutdown warns and resolves. A value that is not a finite number above zero, or is above `120000`, means the default. |
| `env`                                  | the process environment      | The environment the library reads. The OpenTelemetry SDK itself always reads the process environment.                                                                          |

### Environment variables

The library reads these in one source file, and a test fails if any other file names `process.env`:

| Variable                                                                                                          | Effect                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_SDK_DISABLED`                                                                                               | `true` disables the SDK, in any letter case and with surrounding whitespace ignored, as the SDK reads it.                                 |
| `OTEL_SERVICE_NAME`                                                                                               | Service name; overrides the option, because the operator's standard variable wins over what the code chose. Blank values count as absent. |
| `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`                                                                     | Metrics and logs are exported only when these name an exporter.                                                                           |
| `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_EXPORT_TIMEOUT`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | Mapped onto the batch span processor the library passes; the SDK applies them only to one it builds itself.                               |
| `OTEL_NODE_RESOURCE_DETECTORS`                                                                                    | Selects resource detectors, under the specification's names (`service`, `host`, `process`) and the SDK's older ones.                      |

The OpenTelemetry SDK reads these itself, and the library never touches them: `OTEL_EXPORTER_OTLP_*`, `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`, `OTEL_RESOURCE_ATTRIBUTES`.

---

## 🧭 How It Behaves

### The preload

`./register` is for `node --import`. It registers the loader hook, starts the SDK from the standard variables and flushes on a natural exit. It is ES-module only in substance: requiring it from CommonJS throws and names `node --import`, because starting the SDK is asynchronous and a `--require` preload cannot wait for it, which would let the application load first, unnoticed.

The start emits these warnings:

| Code                                        | Meaning                                                                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BYMAX_TELEMETRY_START_FAILED`              | The SDK could not start (a peer is missing, or the SDK threw). Tracing is off.                                                                                                |
| `BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE`      | The loader hook could not be registered. Native-ESM code is not instrumented.                                                                                                 |
| `BYMAX_TELEMETRY_SERVICE_NAME_MISSING`      | No service name is set; spans use `unknown_service:node`.                                                                                                                     |
| `BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED` | A redaction was turned off through an `unsafe` option.                                                                                                                        |
| `BYMAX_TELEMETRY_OPTIONS_IGNORED`           | A `startTelemetry` call reached an SDK that was already running, so its options were ignored, or `enabled: false` did not stop it. Any defined option counts, `env` included. |
| `BYMAX_TELEMETRY_RESTART_UNSUPPORTED`       | `startTelemetry` was called after a shutdown in the same process, and is refused.                                                                                             |
| `BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT`          | The final flush did not finish within `shutdownTimeoutMs`. Shutdown resolved without it, and spans still queued may be lost.                                                  |
| `BYMAX_TELEMETRY_EXPORT_FAILED`             | A span export failed, so the batch was dropped. The warning names the exporter and a short error code, never the payload or the endpoint, and repeats at most once a minute.  |

The programmatic `startTelemetry` keeps its rejection when the SDK cannot start, for callers that want it.

### What is traced

- **Load order matters only for modules your application loads itself.** The core `http` module is patched even when the preload runs after it. A client such as `ioredis` is patched only if the preload ran before the application required it. Measured: an application that required `ioredis` first exported no `ioredis` span.
- **`ioredis` commands are traced only under an active span; node-redis commands are not.** The `ioredis` instrumentation defaults to `requireParentSpan: true`, so a command issued outside any request produces no span. The node-redis (`redis`) instrumentation defaults to `false`, so it traces a command with no request around it too. Measured with `redis` 5.
- **`fs` instrumentation is off by default**, because it floods traces with disk activity that has no context. Turn it on with `instrumentations.fs`.

### Flushing

Awaiting `shutdown()` or `shutdownTelemetry()` means the spans were exported, whoever started the flush, unless the deadline below passed first: overlapping callers wait for the same flush, and a shutdown that arrives while the SDK is still starting waits for the start and then stops what it built. A flush the collector refuses is reported, never thrown into your shutdown path, by the Nest module; the programmatic functions reject, so their caller decides.

The wait is bounded. A collector that accepts a connection and never answers would otherwise hold shutdown for the exporter's own timeout, ten seconds by default, so a flush that has not finished within `shutdownTimeoutMs` (5 seconds unless set, at most 120 seconds) stops holding the caller: shutdown emits `BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT` and resolves. The flush keeps running in the background and a failure after the deadline is dropped. Spans still queued at that point may be lost.

A start after a shutdown in the same process is refused: `startTelemetry` rejects, with an error that says to start once per process (in a test suite, once in a global setup), and the process emits `BYMAX_TELEMETRY_RESTART_UNSUPPORTED`. Auto-instrumented spans can never resume after a shutdown, because the modules the first start instrumented are already patched against its tracer provider; spans created through the API could, but a half-working restart is refused on purpose. Measured with an in-process HTTP request and one manual span per run: after a restart that released the API globals, the manual span was exported and the HTTP spans were not. The preload turns the refusal into a `BYMAX_TELEMETRY_START_FAILED` warning and the application still boots.

---

## 🏭 Production

Every figure here was measured on one laptop, with Node 24 and a handler that does nothing but answer. Read them as orders of magnitude for your own measurement to confirm, not as promises.

- **Sampling.** The default samples every trace. For high traffic set `OTEL_TRACES_SAMPLER=parentbased_traceidratio` and `OTEL_TRACES_SAMPLER_ARG=0.1`. Of 2,000 spans created in one run each, the default exported all of them, a ratio of `0.1` exported 210 and a ratio of `0.01` exported 25.
- **TLS to the collector.** Against a collector whose certificate Node does not trust, every export failed with `self-signed certificate`. Setting `OTEL_EXPORTER_OTLP_CERTIFICATE` to the CA file, or `NODE_EXTRA_CA_CERTS`, exported all 2,000 spans in the same setup.
- **A collector that is down.** The batch is dropped and the library emits `BYMAX_TELEMETRY_EXPORT_FAILED`, at most once a minute. Shutdown stops waiting at `shutdownTimeoutMs`, 5 seconds by default. Before that deadline existed, shutdown against a closed port took 7,048 ms and 7,214 ms in two runs.
- **CPU.** One process, 4 runs per mode, median CPU time per request: 25 µs without the library, 26 µs with it loaded and disabled, 58 µs with a healthy collector (range 35 to 66) and 43 µs with the collector down (range 26 to 65). The extra cost in that handler is roughly 10 to 40 µs per request, and a handler that does real I/O dilutes it. The same configuration varied by up to a factor of two between runs.
- **Memory.** After 10 seconds idle, RSS was 61 to 63 MB without the library and with it disabled, 83 to 95 MB with a healthy collector and 142 to 160 MB with the collector unreachable. Under sustained load with the collector unreachable, the default settings reached roughly 260 to 300 MB, and the same configuration varied between 259 and 302 MB across runs.
- **Small containers.** `node --max-semi-space-size=8` is an optional V8 lever that shrinks the young generation. Under the same unreachable-collector load, RSS had a median of 138 MB (maximum 158) against the 259 to 302 MB above, and p99 latency was 18 ms against 11 ms. Those are one run each, so they are noisy, and a setting of 4 did not do better than 8 (median 219 MB). The extra memory with the collector down is most likely churn from failed exports, which was not measured separately.

## 🔄 OpenTelemetry Versions

Every `@opentelemetry/*` package is an optional peer. The `0.x` packages break between minors, and `sdk-node` pins its own dependencies to exact versions, so the ranges here name only the generation the tests run against:

| Package                                     | Range      |
| ------------------------------------------- | ---------- |
| `@opentelemetry/api`                        | `^1.10.0`  |
| `@opentelemetry/sdk-node`                   | `^0.301.0` |
| `@opentelemetry/exporter-trace-otlp-http`   | `^0.301.0` |
| `@opentelemetry/instrumentation`            | `^0.301.0` |
| `@opentelemetry/sdk-trace`                  | `^3.1.0`   |
| `@opentelemetry/resources`                  | `^3.1.0`   |
| `@opentelemetry/auto-instrumentations-node` | `^0.83.0`  |

A caret on a `0.x` version allows patch releases only, so each OpenTelemetry minor needs a release of this package to widen the range. That is a human decision: a weekly job runs the unit and end-to-end suites, the build and the tarball checks against the newest release of every OpenTelemetry package, ignoring the lockfile, and opens an issue when they fail. A range is widened in a pull request after the job passes against the new generation. Dependabot groups the OpenTelemetry packages, so they move as one set.

---

## 🩺 Troubleshooting

| You see                                                               | Look at                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No spans at all                                                       | `OTEL_SDK_DISABLED`; that the application was started with `--import`; `OTEL_EXPORTER_OTLP_ENDPOINT`; the start warnings.                                                                                                                                            |
| Spans from a CommonJS app but none from a native-ESM app              | `BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE`: install `@opentelemetry/instrumentation`.                                                                                                                                                                                    |
| Spans arrive but carry no service name                                | `BYMAX_TELEMETRY_SERVICE_NAME_MISSING`: set `OTEL_SERVICE_NAME` or the `serviceName` option. A name set only through `OTEL_RESOURCE_ATTRIBUTES` still reaches the spans, unless `OTEL_NODE_RESOURCE_DETECTORS` leaves out both the `env` and the `service` detector. |
| `BYMAX_TELEMETRY_START_FAILED`                                        | The warning names the cause, usually an OpenTelemetry peer that is not installed.                                                                                                                                                                                    |
| HTTP spans but no Redis spans                                         | `ioredis` commands are traced under an active span only, and the client must be loaded after the preload.                                                                                                                                                            |
| Metrics or logs missing                                               | They are off unless `OTEL_METRICS_EXPORTER` or `OTEL_LOGS_EXPORTER` names an exporter.                                                                                                                                                                               |
| The last spans of another module are lost when the application closes | List `TelemetryModule` first in the application module's imports, so it closes last.                                                                                                                                                                                 |
| No spans arrive and nothing else is logged                            | `BYMAX_TELEMETRY_EXPORT_FAILED`: the collector did not accept the export. Check the endpoint in `OTEL_EXPORTER_OTLP_ENDPOINT` and that the collector is reachable.                                                                                                   |
| The last spans are lost on `SIGTERM`                                  | Call `app.enableShutdownHooks()` in Nest, or `shutdownTelemetry()` from your own shutdown path.                                                                                                                                                                      |
| A query string still appears in a span                                | It is on an attribute other than `url.query`, `url.full`, `http.url` or `http.target`: see [What This Library Does NOT Do](#-what-this-library-does-not-do).                                                                                                         |

---

## 🏗️ Architecture

```
node --import @bymax-one/nest-telemetry/register
  → Preload       registers the ES-module loader hook, then starts the SDK from the
                  standard OTEL_* variables; a failure is a warning
  → startTelemetry(options)
                  disabled? returns a no-op handle and loads no OpenTelemetry package
  → Assembly      resource attributes, instrumentation configuration with the redaction
                  applied on top of the host's overrides, signal plan (traces only unless
                  an exporter is named)
  → NodeSDK       resource detectors (OTEL_NODE_RESOURCE_DETECTORS), a batch span processor
                  and a span processor that redacts URL attributes as each span ends
  → Handle        stored under a Symbol.for key on globalThis: one SDK per process,
                  one shared flush
  → Application code (traced)
  → TelemetryShutdownHook
                  Nest's OnApplicationShutdown awaits shutdownTelemetry(); a refused flush
                  is reported under TRACING_FLUSH_FAILED
```

The SDK part is plain functions over the OpenTelemetry packages, loaded on demand with dynamic imports so a disabled boot touches none of them. The environment is read in one module and handed to everything else as a parameter.

---

## 🔐 Security Model

A span can carry whatever an instrumentation or your code records on it. This package redacts what it can know is dangerous, by default, and says plainly what it does not cover.

The layers are in the [Security Table](#-security-table) below.

### Exported on purpose

The resource carries `host.name`, `os.*`, `process.pid`, `process.owner`, the executable path and runtime facts, and `service.instance.id`. They identify the instance during an incident. If you do not want them, set `OTEL_NODE_RESOURCE_DETECTORS`.

### How this is verified

The packed tarball is installed and run with real `node --import` processes, in a CommonJS application and a native-ESM application, against a local OTLP receiver and a fake Redis. A real HTTP request carries a planted query secret and a real `EVAL` carries a planted argument; both are absent from the whole exported body, while the HTTP spans and the Redis command name are present. Negative controls (no loader hook, no preload, a preload loaded after `ioredis`, `OTEL_SDK_DISABLED=true`) export no such span, so the checks can fail. The span-end layer works on attributes, so it applies to spans from any instrumentation; an instrumentation the proofs do not exercise is not proven individually.

What is **not** redacted is listed flat in [What This Library Does NOT Do](#-what-this-library-does-not-do). To report a vulnerability, follow [SECURITY.md](./SECURITY.md).

---

## 🛡️ Security Table

| Layer                | Implementation                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Query redaction      | `url.query` is replaced by `[redacted]` and the query is cut from `url.full`, `http.url` and `http.target` as each span ends, for any instrumentation                                                                                                   |
| Outgoing URLs        | The HTTP instrumentation redacts a credential-parameter list (`token`, `code`, `access_token`, `signature`, `X-Amz-*`, and more); hosts add names, never drop them; a test compares the list with the SDK's own, so a name the SDK adds later is caught |
| Redis                | `db.query.text` holds the command name only, for `ioredis` and node-redis; `EVAL` and `EVALSHA` payloads, which carry `KEYS` and `ARGV`, and every key never leave the process                                                                          |
| Process command line | `process.command_args` and `process.command_line` are dropped from the resource, because command-line arguments are a common carrier of secrets                                                                                                         |
| Opt-outs             | Literal `unsafe.*: true` options only, each emitting a `SecurityWarning`; no environment variable turns redaction off                                                                                                                                   |
| Overrides            | `instrumentations.overrides` is merged under the library's redaction, which is applied again on top                                                                                                                                                     |
| Environment          | Read in one module; a test fails if any other file names `process.env`                                                                                                                                                                                  |
| Supply chain         | `"dependencies": {}`; every OpenTelemetry package is an optional peer                                                                                                                                                                                   |

> [!IMPORTANT]
> Redaction protects the attributes it knows about. Secrets that reach a span some other way, such as a token inside a URL path or a value written into SQL text, are yours to keep out. The flat list is in [What This Library Does NOT Do](#-what-this-library-does-not-do).

---

## 🧱 Tech Stack

[![OpenTelemetry](https://img.shields.io/badge/OpenTelemetry-0.301-425CC7?style=flat-square&logo=opentelemetry&logoColor=white)](https://opentelemetry.io)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?style=flat-square&logo=nestjs)](https://nestjs.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-24-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Jest](https://img.shields.io/badge/Jest-30-C21325?style=flat-square&logo=jest)](https://jestjs.io)
[![Stryker](https://img.shields.io/badge/Stryker-Mutation_Testing-red?style=flat-square)](https://stryker-mutator.io)
[![pnpm](https://img.shields.io/badge/pnpm-11-F69220?style=flat-square&logo=pnpm&logoColor=white)](https://pnpm.io)
[![tsup](https://img.shields.io/badge/tsup-9-orange?style=flat-square)](https://tsup.egoist.dev)

---

## 🧪 Testing & Quality

A tracing library sits on the boot path of every service that installs it, and its redaction is what keeps secrets out of a tracing backend, so the suite is held to a bar beyond "it runs".

- ✅ **100% coverage** — statements, branches, functions and lines, enforced in the unit suite, in the end-to-end suite and in both together, with no exclusions
- ✅ **100% mutation score** — verified with [Stryker](https://stryker-mutator.io/) on a cold run against a `break` threshold of 100, and every unit test confirmed to have run in the mutation run (see the [report](./docs/mutation_testing_results.md))

```bash
pnpm test              # unit tests (Jest)
pnpm test:e2e          # end-to-end tests
pnpm test:cov:all      # full coverage gate (unit + e2e together)
pnpm mutation          # Stryker mutation testing (100% break gate)
pnpm check:runtime     # packed-tarball consumer proofs
```

> [!NOTE]
> Line coverage proves a line _executed_ under test; mutation testing proves a test _would fail_ if that line were wrong. The full methodology and the figures are in [docs/mutation_testing_results.md](./docs/mutation_testing_results.md).

---

## 📖 API Reference

### SDK: `@bymax-one/nest-telemetry`

| Export                          | Signature                                                  | Purpose                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startTelemetry`                | `(options?: TelemetryOptions) => Promise<TelemetryHandle>` | Assembles and starts the SDK; returns the running handle when one exists; rejects when the SDK cannot start or was already shut down in this process          |
| `shutdownTelemetry`             | `() => Promise<void>`                                      | Waits for a start in progress, then flushes and stops the SDK; resolves at once when none was started                                                         |
| `ignorePaths`                   | `(patterns: readonly RegExp[]) => (request) => boolean`    | Predicate for `ignoreIncomingRequest`: matches the request path with its query cut; a request with no target, or a path over 2,048 characters, is not matched |
| `DEFAULT_REDACTED_QUERY_PARAMS` | `readonly string[]`                                        | The credential-parameter list redacted from outgoing request URLs                                                                                             |
| `TelemetryOptions`              | type                                                       | The options of `startTelemetry` ([Configuration](#-configuration))                                                                                            |
| `TelemetryHandle`               | type                                                       | `{ enabled: boolean, shutdown(): Promise<void> }`                                                                                                             |
| `UnsafeOptions`                 | type                                                       | The literal-`true` redaction opt-outs                                                                                                                         |
| `InstrumentationOptions`        | type                                                       | `fs`, `sendLogs` and `overrides`                                                                                                                              |
| `IncomingRequestTarget`         | type                                                       | What an incoming-request predicate sees: the request `url`                                                                                                    |

`ignorePaths` copies each pattern without its `g` and `y` flags, which would keep state between calls. Anchor the patterns at both ends, with no nested quantifiers: an unanchored one also matches routes that merely contain the word, and `/^\/(a+)+$/` took 2.5 s and 5.5 s in two runs on a 28-character path, and the time grows exponentially with the length.

### Register: `@bymax-one/nest-telemetry/register`

No exports. `node --import @bymax-one/nest-telemetry/register` registers the loader hook, starts the SDK from the standard variables and flushes on a natural exit. It emits the warning codes in [The preload](#the-preload).

### Nest: `@bymax-one/nest-telemetry/nest`

| Export                       | Kind     | Purpose                                                                                              |
| ---------------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `TelemetryModule`            | module   | Global; registers `TelemetryShutdownHook`. List it first in the application module's imports         |
| `TelemetryShutdownHook`      | provider | `OnApplicationShutdown`: awaits `shutdownTelemetry()`; a refused flush is reported and never rejects |
| `TELEMETRY_LOGGER`           | token    | Optional provider with an `errorStructured(logKey, error)` method, used to report a failed flush     |
| `TELEMETRY_FLUSH_FAILED_KEY` | constant | The stable key, `TRACING_FLUSH_FAILED`, under which a failed flush is reported                       |
| `ITelemetryErrorLogger`      | type     | The shape `TELEMETRY_LOGGER` provides: `errorStructured(logKey, error)`                              |

---

## 🚫 What This Library Does NOT Do

By design, the following are out of scope:

- ❌ **Redact secrets in the URL path** — only the query string is removed. A path such as `/reset/<token>` is exported as it is
- ❌ **Redact SQL text with inline literals** — database instrumentations record the statement, and values written into it are exported. A value bound to a placeholder is not recorded by `instrumentation-mysql2` 0.71, measured with mysql2 2.3.3, 3.0.0, 3.9.0 and 3.24.6; a canary in the proofs fails if that stops being true
- ❌ **Redact `exception.message` in span events** — an exception's message is exported as recorded
- ❌ **Redact the text of database driver errors** — not measured; an error recorded on a span carries whatever message the driver wrote
- ❌ **Redact the memcached key** — `db.memcached.key` is recorded on every memcached span
- ❌ **Redact an SNS phone number** — a publish to a `PhoneNumber` records the number as the destination name
- ❌ **Redact the Kafka message key** — `messaging.kafka.message.key` is recorded on producer and consumer spans
- ❌ **Redact gRPC error messages** — `grpc.error_message` is recorded when a call fails
- ❌ **Stop the OpenAI instrumentation from capturing prompts** — it reads `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` itself, and when that is set, message content is recorded
- ❌ **Redact span names your own code builds from raw URLs**
- ❌ **Redact baggage**
- ❌ **Redact request and response bodies, or HTTP headers** — they are not captured by default, and they are not redacted if you enable capturing them
- ❌ **Redact attributes your own code sets**
- ❌ **Redact log records forwarded through `OTEL_LOGS_EXPORTER`** — the library redacts spans, and a log record is exported as the logger produced it, so redact in the logger. Measured with `@bymax-one/nest-logger` 1.4.17, which redacts before it hands the record over: a password and a nested token never reached the collector, and the `[REDACTED]` marker did. A plain pino logger with no redaction exported its password
- ❌ **Choose a sampler** — configure `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`
- ❌ **Run a collector or a backend** — point `OTEL_EXPORTER_OTLP_ENDPOINT` at one
- ❌ **Decide your span names** — those come from the instrumentations and from your code
- ❌ **Start again after a shutdown in the same process** — `startTelemetry` is refused, because auto-instrumented modules stay patched against the first SDK
- ❌ **Install a signal handler** — handling `SIGTERM` belongs to the application
- ❌ **Provide strict semantic versioning** — each release in the [CHANGELOG](./CHANGELOG.md) says what changed and what to do about it, and the version number alone is not the compatibility information

---

## 🤝 Contributing

The workflow, the commit convention and the checks to run before a pull request are in [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## 🔒 Security Policy

If you discover a security vulnerability, please **do not** open a public issue. Follow [SECURITY.md](./SECURITY.md), or email us at **support@bymax.one** with details. We take security seriously and will respond promptly.

---

## 📄 License

[MIT](./LICENSE) © [Bymax One](https://github.com/bymaxone)

---

<p align="center">
  <sub>Built with ❤️ by <a href="https://github.com/bymaxone">Bymax One</a></sub>
</p>
