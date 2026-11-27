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
- **🔒 Secret-safe by default** — Span data is a leak surface, so URL query strings, Redis arguments and the process command line are redacted unless an explicit option, which also warns, turns one off. No environment variable turns a redaction off.
- **🚦 Preload ordering done right** — The SDK has to start before the libraries it instruments load, and `main.ts` is too late; a `node --import` preload runs first and takes its settings from environment variables.
- **🔌 Your policy, your rules** — Enabling, probe paths, service name and version, extra redacted parameters and the structured logger are passed in.

Install it with the OpenTelemetry peers you use: the command is in [Quick Start](#-quick-start).

---

## 🔥 Features

### 🚦 Boot and lifecycle

- ✅ **`node --import` preload** — Registers the ES-module loader hook, starts the SDK from the environment variables and flushes on a natural exit
- ✅ **One SDK per process** — The handle lives under a `Symbol.for` key on `globalThis`, so an ES-module preload and a CommonJS application share it, and a second start returns the one already running
- ✅ **Graceful Nest shutdown** — `TelemetryModule` awaits the flush as part of the application's own shutdown, under the stable failure key `TRACING_FLUSH_FAILED`
- ✅ **Never takes the host down** — Each failure the preload can meet is a warning and the application still starts; a flush the collector refuses is reported by the Nest module, never thrown into your shutdown path

### 🔐 Redaction

- ✅ **Span-end query redaction** — `url.query` is replaced and the query is cut from `url.full`, `http.url` and `http.target`, on spans from any instrumentation
- ✅ **Outgoing-URL credential list** — A list of credential-bearing parameters, checked in a test against the SDK's own default list; a host can add names and never drop them
- ✅ **Parse errors do not quote their input** — the part of a request body that a `JSON.parse` message repeats is removed from the span status and exception events; `redactExceptionText` removes every exception message
- ✅ **Redis commands reduced to their name** — for `ioredis` and node-redis (`redis`), arguments and keys never leave the process, `EVAL` and `EVALSHA` payloads included
- ✅ **Command line kept out of the resource** — `process.command_args`, `process.command_line` and `process.command` are dropped
- ✅ **Explicit, loud opt-outs** — Each off switch is a literal `unsafe.*: true` and emits a `SecurityWarning`

---

## 📦 Subpath Exports

One package, separate entry points. Import only what your app needs:

| Subpath           | Import                                    | Purpose                                                                                                                                                                                       |                   Dependencies                   |
| ----------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------: |
| **SDK**           | `@bymax-one/nest-telemetry`               | `startTelemetry`, `shutdownTelemetry`, `ignorePaths`, `DEFAULT_REDACTED_QUERY_PARAMS`, types                                                                                                  |               OpenTelemetry peers                |
| **Register**      | `@bymax-one/nest-telemetry/register`      | The preload for `node --import`; importing it runs it, and it exports nothing                                                                                                                 |               OpenTelemetry peers                |
| **Nest**          | `@bymax-one/nest-telemetry/nest`          | `TelemetryModule`, `TelemetryShutdownHook`, `TELEMETRY_LOGGER`, `TELEMETRY_FLUSH_FAILED_KEY`, `TELEMETRY_SHUTDOWN_TIMEOUT_KEY`, `TELEMETRY_EXPORT_FAILED_KEY`, `ITelemetryErrorLogger` (type) |                    NestJS 11                     |
| **Observability** | `@bymax-one/nest-telemetry/observability` | `TelemetryMetrics`, `SPAN_EXPORT_FAILURES_METRIC`                                                                                                                                             | NestJS 11, `@bymax-one/nest-core`, `prom-client` |

The SDK entry and `./register` import no `@nestjs/*` package; only `./nest` and `./observability` do. `./observability` is optional: it needs `@bymax-one/nest-core` and `prom-client`, which are optional peers, and the other entries never load them. Requiring `./register` from CommonJS throws and names `node --import`.

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

This package installs no signal handler and shows none, because handling signals belongs to the application: a `SIGTERM` listener replaces Node's default termination, so it has to end the process itself once its work is done. `startTelemetry` resolves to a handle with `enabled` and `shutdown()`. Starting twice returns the handle already running (unless `enabled: false`, which returns a disabled handle), including across two copies of the module (an ES-module preload and a CommonJS application share the handle through `globalThis`). A later call that passes options is told they were ignored, and `enabled: false` against a running SDK is told it does not stop it: `shutdownTelemetry()` does.

---

## ⚙️ Configuration

### `startTelemetry(options)`

Every field is the host's policy, and none is required.

| Option                                 | Type                                          | Default                      | What it does                                                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                              | `boolean`                                     | `true`                       | `false` never starts the SDK. `OTEL_SDK_DISABLED=true` disables it regardless.                                                                                                                                                                    |
| `serviceName`                          | `string`                                      | `unknown_service:node`       | The service name. `OTEL_SERVICE_NAME` overrides it.                                                                                                                                                                                               |
| `serviceVersion`                       | `string`                                      | none                         | The service version.                                                                                                                                                                                                                              |
| `ignoreIncomingRequest`                | `(request: IncomingRequestTarget) => boolean` | none                         | Returns `true` for an incoming request that must produce no server span. `ignorePaths(patterns)` builds one from anchored patterns. It must be synchronous (see below).                                                                           |
| `instrumentations.fs`                  | `boolean`                                     | `false`                      | File-system instrumentation.                                                                                                                                                                                                                      |
| `instrumentations.sendLogs`            | `boolean`                                     | follows `OTEL_LOGS_EXPORTER` | Whether the records of pino, winston and bunyan are forwarded to the OpenTelemetry logs pipeline. Winston also needs `@opentelemetry/winston-transport` installed by your application, see [Forwarding log records](#forwarding-log-records).     |
| `instrumentations.overrides`           | `InstrumentationConfigMap`                    | none                         | Per-instrumentation configuration, merged over the library's. Redaction settings cannot be replaced here.                                                                                                                                         |
| `extraRedactedQueryParams`             | `readonly string[]`                           | none                         | Names added to the list redacted from outgoing request URLs. They add to the defaults and never replace them.                                                                                                                                     |
| `redactExceptionText`                  | `boolean`                                     | `false`                      | Replaces the text of every recorded exception, see [Exception text](#exception-text). Without the option, `BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT` decides.                                                                                        |
| `unsafe.disableUrlRedaction`           | `true`                                        | off                          | Keeps `url.query`, `url.full`, `http.url` and `http.target` as recorded. Literal `true`. Warns.                                                                                                                                                   |
| `unsafe.disableRedisArgumentRedaction` | `true`                                        | off                          | Keeps Redis command arguments in `db.query.text`. Literal `true`. Warns.                                                                                                                                                                          |
| `unsafe.exportProcessCommandArgs`      | `true`                                        | off                          | Keeps `process.command_args`, `process.command_line` and `process.command` in the resource. Literal `true`. Warns.                                                                                                                                |
| `unsafe.exportHostId`                  | `true`                                        | off                          | Keeps `host.id`, the machine identifier, in the resource. Literal `true`. Warns.                                                                                                                                                                  |
| `shutdownTimeoutMs`                    | `number`                                      | `5000`                       | The longest shutdown waits for the final flush. Past it, shutdown warns and resolves. A value that is not a finite number above zero, or is above `120000`, means the default.                                                                    |
| `env`                                  | `NodeJS.ProcessEnv`                           | the process environment      | The environment the library reads its variables from, except `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`, which are always read from the process environment, as the SDK reads them. The SDK itself always reads the process environment. |

A key set to `undefined` or `null` in any option is the same as no key. An override is copied by its own enumerable keys, so pass a plain object: getters on a class prototype are not read.

### Exception text

An instrumentation records an error on its span as the status message and as an exception event with `exception.type`, `exception.message` and `exception.stacktrace`. Messages often repeat the data that caused them.

**Always, with no opt-out:** the input that a `JSON.parse` message quotes is removed. V8 writes messages such as `Unexpected token 'p', "password=hunter2" is not valid JSON`, so a malformed request body would otherwise reach the tracing backend. In each of those texts, a text that holds `is not valid JSON` is replaced up to the last occurrence by `[redacted] `, whatever shape it has, keeping a recognised leading error class name and what follows the words (after a message that names a token, such as the one above, only stack frames are kept there): `SyntaxError: [redacted] is not valid JSON`. A message that was cut before that ending but holds `Unexpected token 'x', ` is redacted whole too. The other `JSON.parse` messages of Node 24 carry no input. This covers a text of your own that holds those words too.

**Only with `redactExceptionText` on:** every other message, such as the one a database driver writes (PostgreSQL quotes the value it rejected) or one your code builds. The status message and `exception.message` become `[redacted]`, and `exception.stacktrace` keeps the frames under `[redacted]` and any recognised error class name; `exception.type` stays. Frames followed by other text, such as a cause, are dropped too, and a stack longer than 32,768 characters recorded with a message keeps no frames, nor does one that a length limit cut inside the message (under an error name of up to 256 characters). A message or stack that is not a string becomes `[redacted]`. If your code changed a message after its stack was captured, a line of the old message written exactly like a frame, right above the real ones, can remain.

```typescript
await startTelemetry({ redactExceptionText: true })
```

With the `./register` preload, or wherever the option is not given, the variable does the same:

```bash
BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT=true node --import @bymax-one/nest-telemetry/register dist/main.js
```

Only `true` and `1`, written exactly, turn it on. Unset, empty, `false` and `0` leave it off, and any other value leaves it off with a `BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT_UNKNOWN` warning. The option wins when both are given: `false` keeps it off with the variable set, and `true` turns it on whatever the variable holds.

The default reads arrays of text too. If the redaction itself fails, the span still ends and every event of the span is removed; the message of an error status becomes `[redacted]`, and any other status loses its message. A span that code in the process altered to refuse those two writes keeps what it held.

One limit of the default: when `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT` cuts a text before `is not valid JSON`, it is recognised only by `Unexpected token 'x', `. Another text that quotes data that way, written by your code, a library or a later engine, is exported as cut; `redactExceptionText` covers it.

Neither reaches other span attributes (`error.message`, `grpc.error_message`, SQL text), link attributes, span names or log records.

`ignoreIncomingRequest` must be synchronous, because the HTTP instrumentation reads its answer at once:

- A promise, or any other object with a `then` method, does not ignore the request, whatever it settles with. Its rejection is absorbed, and the first one emits the `BYMAX_TELEMETRY_IGNORE_HOOK_ASYNC` warning.
- A synchronous throw does not ignore the request either: the instrumentation catches it and traces the request. It is reported only to the OpenTelemetry diagnostic logger, with the error's own message.

An `ignoreIncomingRequestHook` set through `instrumentations.overrides` is OpenTelemetry's own hook: the library passes it on unguarded, so an asynchronous one leaves every request untraced and an unhandled rejection of it ends the process by default. The `ignoreIncomingRequest` option, when given, replaces it.

### Environment variables

The library reads these in one source file, and a test fails if any other file names `process.env`:

| Variable                                                                                                          | Effect                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_SDK_DISABLED`                                                                                               | `true` disables the SDK, in any letter case and with surrounding whitespace ignored, as the SDK reads it.                                                                                                                     |
| `OTEL_SERVICE_NAME`                                                                                               | Service name; overrides the option, because the operator's standard variable wins over what the code chose. Blank values count as absent.                                                                                     |
| `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`                                                                     | Metrics and logs are exported only when these name an exporter.                                                                                                                                                               |
| `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_EXPORT_TIMEOUT`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | Mapped onto the batch span processor the library passes; the SDK applies them only to one it builds itself. A schedule delay or export timeout above 2147483647 ms is ignored with a warning, because a timer cannot hold it. |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`                                                                  | The SDK acts on them. The library only reads them to warn when the SDK will ignore a ratio argument or sample every trace; see the warning table.                                                                             |
| `OTEL_NODE_RESOURCE_DETECTORS`                                                                                    | Selects resource detectors, under the specification's names (`service`, `host`, `process`) and the SDK's older ones.                                                                                                          |
| `BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT`                                                                           | `true` or `1` turns on [`redactExceptionText`](#exception-text) when the option is not given.                                                                                                                                 |

The OpenTelemetry SDK reads these itself, and the library never touches them: `OTEL_EXPORTER_OTLP_*` and `OTEL_RESOURCE_ATTRIBUTES`.

---

## 🧭 How It Behaves

### The preload

`./register` is for `node --import`. It registers the loader hook, starts the SDK from the environment variables and flushes on a natural exit. It is ES-module only in substance: requiring it from CommonJS throws and names `node --import`, because starting the SDK is asynchronous and a `--require` preload cannot wait for it, which would let the application load first, unnoticed.

The library emits these warnings:

| Code                                            | Meaning                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BYMAX_TELEMETRY_START_FAILED`                  | The SDK could not start (a peer is missing, or the SDK threw). Tracing is off.                                                                                                                                                                                                                                                                       |
| `BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE`          | The loader hook could not be registered. Native-ESM code is not instrumented. The warning names the error's code and package in the same way.                                                                                                                                                                                                        |
| `BYMAX_TELEMETRY_SERVICE_NAME_MISSING`          | No service name is set; spans use `unknown_service:node`.                                                                                                                                                                                                                                                                                            |
| `BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED`     | A redaction was turned off through an `unsafe` option.                                                                                                                                                                                                                                                                                               |
| `BYMAX_TELEMETRY_OPTIONS_IGNORED`               | A `startTelemetry` call reached an SDK that was already running, so its options were ignored, or `enabled: false` did not stop it. Any option that is neither `undefined` nor `null` counts, `env` included.                                                                                                                                         |
| `BYMAX_TELEMETRY_RESTART_UNSUPPORTED`           | `startTelemetry` was called after a shutdown in the same process, and is refused.                                                                                                                                                                                                                                                                    |
| `BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT`              | The final flush did not finish within `shutdownTimeoutMs`. Shutdown resolved without it, and spans still queued may be lost. With `TelemetryModule` and a bound `TELEMETRY_LOGGER`, it is reported through `errorStructured` under `TRACING_SHUTDOWN_TIMEOUT` instead.                                                                               |
| `BYMAX_TELEMETRY_EXPORT_FAILED`                 | A span export failed, so the batch was dropped. The warning names the exporter and a short error code, never the payload or the endpoint, and repeats at most once a minute. With `TelemetryModule` and a bound `TELEMETRY_LOGGER` that has `warnStructured`, it is reported through it under `TRACING_EXPORT_FAILED` instead.                       |
| `BYMAX_TELEMETRY_SAMPLER_ARG_INVALID`           | A ratio sampler (`traceidratio` or `parentbased_traceidratio`) is selected and `OTEL_TRACES_SAMPLER_ARG` is unset, blank or not a number from 0 to 1, so the SDK samples every trace. Set the share of traces to keep, such as `0.1`.                                                                                                                |
| `BYMAX_TELEMETRY_SAMPLER_NAME_UNKNOWN`          | `OTEL_TRACES_SAMPLER` differs from a sampler name the SDK knows only in letter case or surrounding whitespace. The SDK compares the name exactly, ignores the value and samples every trace. Write the name exactly, as the warning says.                                                                                                            |
| `BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT_UNKNOWN` | `BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT` holds a value that is not `true`, `1`, `false` or `0`, so only the input of a parse error is redacted.                                                                                                                                                                                                       |
| `BYMAX_TELEMETRY_WINSTON_TRANSPORT_MISSING`     | Log forwarding is on and winston is installed, but `@opentelemetry/winston-transport` cannot be resolved from the winston instrumentation, so winston records are not forwarded. Install it as a direct dependency of the application, or ignore the warning when your application never creates a winston logger or `OTEL_LOGS_EXPORTER` is `none`. |
| `BYMAX_TELEMETRY_BSP_VALUE_IGNORED`             | An `OTEL_BSP_SCHEDULE_DELAY` or `OTEL_BSP_EXPORT_TIMEOUT` above 2147483647 ms was ignored, because a timer cannot hold it and Node would clamp it to 1 ms. The default applies.                                                                                                                                                                      |
| `BYMAX_TELEMETRY_IGNORE_HOOK_ASYNC`             | `ignoreIncomingRequest` returned a promise or another thenable for an incoming request, so the request is traced. Return `true` or `false` synchronously. Emitted once.                                                                                                                                                                              |

An option of the wrong kind is refused before anything starts: `startTelemetry` rejects with an error whose `code` is `BYMAX_TELEMETRY_OPTION_INVALID` and whose `option` names it, such as `instrumentations.sendLogs`. The message says what the option must be and never repeats the value. A boolean option (`enabled`, `redactExceptionText`, `instrumentations.fs`, `instrumentations.sendLogs` and each `unsafe` flag) must be a boolean, so the string `'false'` is refused and not read as true; `serviceName` and `serviceVersion` must be strings, `ignoreIncomingRequest` a function, and `unsafe`, `instrumentations`, `instrumentations.overrides` and `env` objects (a plain object, an object with no prototype, a class instance whose chain of prototypes ends within 100 prototypes and the environment object are read as written; an object of a kind Node reports, such as a `Map`, `Set`, `Date`, `RegExp`, `Promise`, `WeakMap`, typed array, `Error` or boxed primitive, and one whose chain of prototypes does not end or is longer than 100, is refused as the wrong kind; a `Proxy` is judged by what it answers and not by its target). `extraRedactedQueryParams` must be an array of at most 1000 strings, and `instrumentations.overrides` an object of at most 1000 entries that are each an object. Inside an override, `enabled` and `disableLogSending` must be booleans, `redactedQueryParams` an array of at most 1000 strings, every setting whose name ends in `Hook` a function, an entry holds at most 1000 settings, and a key named `__proto__` is refused, in an entry and as the name of an instrumentation; an entry or a setting that is `null` or `undefined` is dropped and not refused; any other setting, a function that is not a hook included, is passed on as the host wrote it, except that a plain object inside it is copied with no prototype (so a name a polluted `Object.prototype` holds is not found under it) and a list is copied member by member, at most 16 levels below the setting itself, 10,000 objects and lists in all and 1000 entries to a list or an object, and refused beyond that (these limits are new in 1.0.12, and a setting that nested more than that before is now refused at start); a function, a class instance, a `Map` or a `Proxy` inside it is passed on as it is. The error names the setting as `instrumentations.overrides[].enabled` and never the instrumentation or the value. `null` and `undefined` mean the option was not given. `shutdownTimeoutMs` is not refused: a value that is not a number in range means the default. Each option of a call is read once, so what a warning says and what the call does come from the same read. A value that only a prototype with no prototype holds, other than the root prototype of this realm, is not dropped: the start fails naming the option, so it goes on the options object or on a class; for the `instrumentations.overrides` map and for each of its entries, a setting that any parent object holds (`Object.create({ enabled: false })`) is refused the same way, because a copy of the own keys would drop it; so is a getter or a setter that the class of such an object defines, though the methods of a class are not settings. A key that only the root prototype of the realm holds, as a polluted `Object.prototype` would, is ignored and not read as the host's, whether it is an option of the call (`unsafe`, `instrumentations`, `env`, `enabled` and the rest), a flag inside `unsafe` or `instrumentations`, or an `OTEL_*` variable of the environment; a variable of an `env` object that is not a string is ignored as if it were unset; a field of the object or of a class instance, and a getter of its class, are read as written. The options object of the call must itself be an object of settings: a function or an array is refused. If the `Object.prototype` of the process holds a name that a fresh realm's does not, lacks one, or holds one changed (what a pollution leaves), or when a fresh realm to compare it with cannot be built, `startTelemetry` and the preload start nothing, answer with the disabled handle and emit one `BYMAX_TELEMETRY_REALM_POLLUTED` warning that carries a count and never a name or a value, and every OTLP export (the exporters the SDK builds for metrics and logs included) drops its batch with no I/O while the prototype is polluted; the check of the export wraps the base class that the OTLP exporters share, which is a process-wide effect: while the prototype is polluted, an OTLP exporter that the host builds from this same copy of the packages refuses its batches too. The Prometheus exporter that the SDK can build for metrics is not an OTLP exporter and is not wrapped: it reads its host and port when it is built, which the checks before the SDK is built cover. A host that extends `Object.prototype` (should.js, chai.should, a polyfill) cannot start telemetry. The one reading this does not stop is a version check inside the instrumentations (`includePrerelease`), which an instrumentation makes when a module loads. The check also runs before each request attempt of an exporter's transport, and again just before its headers, metadata or credentials are read and once they have been read, so a name planted while an attempt waits to load, to retry or for an asynchronous headers provider is seen. It relies on the shape of the exporters of the OpenTelemetry release this library is tested with, and it does not cover a custom exporter that does not hold its transport in a `_delegate` or a transport that is swapped for another while an export is already under way. The check and the wrap use only built-ins that were read when the library loaded, so replacing one of them afterwards does not blind them in the ordinary case; code that runs in the process is trusted, and these guards are best-effort and not a security boundary (see SECURITY.md). Replacing one of the members they call after the library loaded is itself counted as a pollution; `Promise` (apart from `Promise[Symbol.species]` and the `constructor` of `Promise.prototype`, which are compared, as is a `then` on `Array.prototype` or `Function.prototype`), timers, `Date`, `EventEmitter`, `http`, `fetch` and `process` are not compared, because tracing agents wrap them by design. A name planted with `Object.defineProperty` as an accessor or a read-only property can still reach a copy of the options as it is written, which is outside what this guards against: whoever can define one already runs code in the process. The same holds for a `detail` or `code` of that kind, which makes the one pollution warning impossible to emit: the start still answers with the disabled handle, with no warning. The wrap of the export is made on the base class of the OTLP exporters that this library loads; an exporter the host builds from another copy of the OpenTelemetry packages (the CommonJS copy, when the library was loaded as ES modules) has another base class and is not wrapped. An options object whose own prototype is an object the host built, for example by merging `JSON.parse` output into it, is read as a class chain: what that object holds is honoured, because it is the host's own object and not the prototype of the process. A name added to `Object.prototype` after a clean start does not stop the process: the guard drops every batch, and the `BYMAX_TELEMETRY_EXPORT_FAILED` warning says that `Object.prototype` or a built-in was changed and that the collector was not contacted.

The programmatic `startTelemetry` keeps its rejection when the SDK cannot start, for callers that want it. It rejects with the error that was thrown, as it was thrown, and only a refused option carries a code, so an option whose getter throws (or a proxy that fails an operation) ends the start with that error and starts no new SDK, so a first start leaves no handle either. A later call that finds an SDK already running can also reject, while it reads the options of the call; the running SDK and its handle are not touched.

### What is traced

- **Load order matters only for modules your application loads itself.** The core `http` module is patched even when the preload runs after it. A client such as `ioredis` is patched only if the preload ran before the application required it. Measured: an application that required `ioredis` first exported no `ioredis` span.
- **`ioredis` commands are traced only under an active span; node-redis commands are not.** The `ioredis` instrumentation defaults to `requireParentSpan: true`, so a command issued outside any request produces no span. The node-redis (`redis`) instrumentation defaults to `false`, so it traces a command with no request around it too. Measured as of 2026-11-13 with `redis` 5 and 6; the proofs in this repository run `redis` 6.
- **`fs` instrumentation is off by default**, because it floods traces with disk activity that has no context. Turn it on with `instrumentations.fs`.

### Forwarding log records

With `OTEL_LOGS_EXPORTER=otlp`, or `instrumentations.sendLogs: true`, the records of pino, winston and bunyan go to the OpenTelemetry logs pipeline. Winston needs one more package: install `@opentelemetry/winston-transport` as a direct dependency of your application. The winston instrumentation loads it with a `require` from its own directory, and the package is not one of that instrumentation's dependencies, so without it winston records are not forwarded. Measured with winston 3.19.0 and `@opentelemetry/winston-transport` 0.35.0: a winston record reached the collector when the package was a direct dependency under npm, under pnpm 11.20.0 with the default layout and under pnpm with `hoist=false`, and it did not under npm without the package. A package that reaches the project only as another package's dependency was not measured.

At start the library warns once, with `BYMAX_TELEMETRY_WINSTON_TRANSPORT_MISSING`, when log sending is on, winston resolves from the script that started the application (from the working directory when there is none), and the transport does not resolve from the winston instrumentation, which is found through `@opentelemetry/auto-instrumentations-node`. The check asks whether winston is installed, not whether it is loaded, because winston is usually not loaded yet at start: an installed winston that your application never uses causes one warning for nothing. The warning also appears with `instrumentations.sendLogs: true` while `OTEL_LOGS_EXPORTER` is `none`, where no record is forwarded whether the transport is installed or not, and with the `console` exporter, where it is correct.

### Metrics

With `@bymax-one/nest-core` and `prom-client` installed, the application can publish how many span exports failed. Provide `TelemetryMetrics` from `@bymax-one/nest-telemetry/observability` in any module; `BymaxCoreModule` finds it and hands it the registry its scrape endpoint serves, only when its metrics feature is on. With metrics off, nothing is created.

```ts
import { Module } from '@nestjs/common'
import { TelemetryMetrics } from '@bymax-one/nest-telemetry/observability'

@Module({ providers: [TelemetryMetrics] })
export class ObservabilityModule {}
```

| Metric                                       | Type    | Labels | Meaning                                                                                                                                                                  |
| -------------------------------------------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bymax_telemetry_span_export_failures_total` | counter | none   | Span export batches the collector did not accept, so the batch was dropped. Every failure is counted, while `BYMAX_TELEMETRY_EXPORT_FAILED` warns at most once a minute. |

The count is the number of failed exports since the process started. It lives on `globalThis`, as the handle does, so it is the same when the SDK starts from the preload and the application loads the library again. The series exists with a value of 0 before the first failure, so an alert on `increase(bymax_telemetry_span_export_failures_total[5m]) > 0` needs no special case. Register the contributor at most once per registry: a second registration of the name fails the boot, and says which name.

### Log events

One entry goes to the Nest logger, under the context `Telemetry`, as an object, so a logger that writes JSON, such as `@bymax-one/nest-logger`, keeps its fields apart:

| `event`                  | Level   | When                                                                  | Fields                                                                                                                                                                                                                                            |
| ------------------------ | ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEMETRY_FLUSH_FAILED` | `error` | The flush on shutdown failed and no `TELEMETRY_LOGGER` took the entry | `message`: library text that starts with `TRACING_FLUSH_FAILED` and names the code. `code`: the failure's code when it is a token of 1 to 40 upper-case letters, digits or underscores, otherwise `UNKNOWN`. Never the failure's message or stack |

The other entries go to a `TELEMETRY_LOGGER` you provide, under the keys `TRACING_FLUSH_FAILED`, `TRACING_SHUTDOWN_TIMEOUT` and `TRACING_EXPORT_FAILED` ([Nest exports](#nest-bymax-onenest-telemetrynest)). Everything else the library reports is a process warning with a `BYMAX_TELEMETRY_*` code ([The preload](#the-preload)).

### Span names across the Bymax libraries

This library starts the SDK and traces what the OpenTelemetry instrumentations cover (HTTP, Redis, databases). The Bymax libraries add spans of their own for their domain operations, under the name `<library>.<operation>`, through the optional `@opentelemetry/api`: with no SDK registered the API does nothing, and with this one started the spans are exported like any other. The standard asks that their attributes use the `bymax.<library>.<attribute>` namespace and closed sets of values, with no secret, no user or tenant id and no payload, and that a failure set the span status to error with the library's error code.

The names below are the ones the Bymax observability standard reserves for each library; they are not read from this repository. A library emits one from the release whose CHANGELOG lists it, and its own README documents the attributes.

| Library                                                                                                                                                                                                                  | Span names                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| [nest-auth](https://github.com/bymaxone/nest-auth)                                                                                                                                                                       | `auth.login`, `auth.refresh`, `auth.mfa.verify`, `auth.password_reset`                                |
| [nest-queue](https://github.com/bymaxone/nest-queue)                                                                                                                                                                     | `queue.enqueue`, `queue.process`                                                                      |
| [nest-notification](https://github.com/bymaxone/nest-notification)                                                                                                                                                       | `notification.send`, `notification.otp.verify`                                                        |
| [nest-storage](https://github.com/bymaxone/nest-storage)                                                                                                                                                                 | `storage.upload`, `storage.download_url`, `storage.scan`                                              |
| [nest-realtime](https://github.com/bymaxone/nest-realtime)                                                                                                                                                               | `realtime.handshake`, `realtime.reauthenticate`                                                       |
| [nest-ai-tokens](https://github.com/bymaxone/nest-ai-tokens)                                                                                                                                                             | `ai_tokens.consume`, `ai_tokens.hold`, `ai_tokens.settle`                                             |
| [nest-core](https://github.com/bymaxone/nest-core), [nest-cache](https://github.com/bymaxone/nest-cache), [nest-logger](https://github.com/bymaxone/nest-logger), [nest-config](https://github.com/bymaxone/nest-config) | none: HTTP and Redis are traced by the instrumentations, and the other work is not a domain operation |

The standard asks `nest-queue` to carry the trace context from the request that enqueues a job into the job, as a W3C `traceparent` in the job's options metadata, so a request, its job and the job's side effects form one trace. That needs the SDK's default propagator: a host that sets `OTEL_PROPAGATORS` to a list without `tracecontext` breaks it. With no SDK registered the propagation writes nothing, and a job without a `traceparent` starts its own trace.

### Flushing

Awaiting `shutdown()` or `shutdownTelemetry()` means the spans were exported, whoever started the flush, unless the deadline below passed first: overlapping callers wait for the same flush, and a shutdown that arrives while the SDK is still starting waits for the start and then stops what it built. The Nest module reports a flush the collector refuses and never throws it into your shutdown path; the programmatic functions reject, so their caller decides.

The wait is bounded. A collector that accepts a connection and never answers would otherwise hold shutdown for the exporter's own timeout, ten seconds by default, so a flush that has not finished within `shutdownTimeoutMs` (5 seconds unless set, at most 120 seconds) stops holding the caller: shutdown emits `BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT` and resolves. The flush keeps running in the background and a failure after the deadline is dropped. Spans still queued at that point may be lost.

A start after a shutdown in the same process is refused: `startTelemetry` rejects, with an error that says to start once per process (in a test suite, once in a global setup), and the process emits `BYMAX_TELEMETRY_RESTART_UNSUPPORTED`. Auto-instrumented spans can never resume after a shutdown, because the modules the first start instrumented are already patched against its tracer provider; spans created through the API could, but a half-working restart is refused on purpose. Measured as of 2026-11-13, in runs that are not part of this repository, with an in-process HTTP request and one manual span per run: after a restart that released the API globals, the manual span was exported and the HTTP spans were not. The preload turns the refusal into a `BYMAX_TELEMETRY_START_FAILED` warning and the application still boots.

---

## 🏭 Production

Every measured figure here was taken on one laptop, with Node 24, as of 2026-11-13; no script in this repository reproduces them. Read them as orders of magnitude for your own measurement to confirm, not as promises.

- **Sampling.** The default samples every trace. For high traffic set `OTEL_TRACES_SAMPLER=parentbased_traceidratio` and `OTEL_TRACES_SAMPLER_ARG=0.1`. Of 2,000 spans created in one run each, the default exported all of them, a ratio of `0.1` exported 210 and a ratio of `0.01` exported 25. A ratio sampler needs `OTEL_TRACES_SAMPLER_ARG` to be a number from 0 to 1. When it is unset, empty or only whitespace, not a number or outside that range, the SDK falls back to a ratio of 1 and samples every trace, noting it only on a diagnostic channel; the start warns once with `BYMAX_TELEMETRY_SAMPLER_ARG_INVALID`, naming the variable and, when a non-blank value was given, the value (cut to 40 characters, with control, separator and invisible characters written as escapes) (a blank value is called blank, not unset, and is not repeated). The SDK matches the sampler name exactly: `always_on`, `always_off`, `traceidratio`, `parentbased_always_on`, `parentbased_always_off` and `parentbased_traceidratio`, in lower case and without surrounding whitespace. Any other value, `TraceIdRatio` included, is replaced by its default and samples every trace; when the value differs from one of those names only in letter case or surrounding whitespace, the start warns once with `BYMAX_TELEMETRY_SAMPLER_NAME_UNKNOWN`, naming the name that was meant and not repeating the value. A name that is not one of those up to case and whitespace, such as `xyz` or a misspelling like `always_offf`, is not warned about: it samples every trace as well, so check the spelling of the variable. It reads the process environment, as the SDK does, and not the `env` option.
- **TLS to the collector.** Against a collector whose certificate Node does not trust, every export failed with `self-signed certificate`. Setting `OTEL_EXPORTER_OTLP_CERTIFICATE` to the CA file, or `NODE_EXTRA_CA_CERTS`, exported all 2,000 spans in the same setup.
- **A collector that is down.** The batch is dropped and the library emits `BYMAX_TELEMETRY_EXPORT_FAILED`, at most once a minute. Shutdown stops waiting at `shutdownTimeoutMs`, 5 seconds by default. Before that deadline existed, shutdown against a closed port took 7,048 ms and 7,214 ms in two runs.
- **CPU.** One process, 4 runs per mode, median CPU time per request: 25 µs without the library, 26 µs with it loaded and disabled, 58 µs with a healthy collector (range 35 to 66) and 43 µs with the collector down (range 26 to 65). The extra cost is roughly 10 to 40 µs per request, and a handler that does real I/O dilutes it. The same configuration varied by up to a factor of two between runs.
- **Memory.** After 10 seconds idle, RSS was 61 to 63 MB without the library and with it disabled, 83 to 95 MB with a healthy collector and 142 to 160 MB with the collector unreachable. Under sustained load with the collector unreachable, the default settings reached between about 195 and 310 MB in one 90-second run.
- **Small containers.** `node --max-semi-space-size=8` is an optional V8 lever that shrinks the young generation. Under the same unreachable-collector load, RSS had a median of 138 MB (maximum 158) against about 195 to 310 MB for the default settings. The memory figures are one run each, so they are noisy, and a setting of 4 did not do better than 8 (RSS levelled at about 220 MB). At 1,000 requests per second against an unreachable collector, p99 latency over three runs each was 3.6 to 7.3 ms with the default settings and 4.8 to 6.8 ms with 8, so no cost showed at that load. The extra memory with the collector down is most likely churn from failed exports, which was not measured separately.

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

The optional peers that are not OpenTelemetry packages are `@bymax-one/nest-core` `^1.1.0`, `prom-client` `^15.0.0`, `@nestjs/common` `^11.0.16`, `@nestjs/core` `^11.1.18`, `reflect-metadata` `^0.2.0` and `rxjs` `^7.8.0`.

A caret on a `0.x` version allows patch releases only, so each OpenTelemetry minor needs a release of this package to widen the range. That is a human decision: a weekly job runs the unit and end-to-end suites, the build and the tarball checks against the newest release of every OpenTelemetry package, ignoring the lockfile, and opens an issue when they fail. A range is widened in a pull request after the job passes against the new generation. Dependabot groups the OpenTelemetry packages, so they move as one set.

---

## 🩺 Troubleshooting

| You see                                                               | Look at                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No spans at all                                                       | `OTEL_SDK_DISABLED`; that the application was started with `--import`; `OTEL_EXPORTER_OTLP_ENDPOINT`; the start warnings.                                                                                                                                            |
| Spans from a CommonJS app but none from a native-ESM app              | `BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE`: install `@opentelemetry/instrumentation`.                                                                                                                                                                                    |
| Spans arrive but carry no service name                                | `BYMAX_TELEMETRY_SERVICE_NAME_MISSING`: set `OTEL_SERVICE_NAME` or the `serviceName` option. A name set only through `OTEL_RESOURCE_ATTRIBUTES` still reaches the spans, unless `OTEL_NODE_RESOURCE_DETECTORS` leaves out both the `env` and the `service` detector. |
| `BYMAX_TELEMETRY_START_FAILED`                                        | The warning names the error's code and, when the message names one, the OpenTelemetry package, usually a peer that is not installed. It never repeats the message, which can quote configuration.                                                                    |
| HTTP spans but no Redis spans                                         | `ioredis` commands are traced under an active span only, and the client must be loaded after the preload.                                                                                                                                                            |
| Requests that `ignoreIncomingRequest` should ignore are still traced  | `BYMAX_TELEMETRY_IGNORE_HOOK_ASYNC`: the hook returns a promise. With no warning, check that it returns `true` for the path and does not throw.                                                                                                                      |
| More traces than the sampling ratio should keep                       | `BYMAX_TELEMETRY_SAMPLER_ARG_INVALID`: `OTEL_TRACES_SAMPLER_ARG` is unset, blank or not a number from 0 to 1, so the SDK samples every trace; or `BYMAX_TELEMETRY_SAMPLER_NAME_UNKNOWN`: `OTEL_TRACES_SAMPLER` is not written exactly (letter case or whitespace).   |
| Winston records missing from the logs pipeline                        | `BYMAX_TELEMETRY_WINSTON_TRANSPORT_MISSING`: install `@opentelemetry/winston-transport` as a direct dependency of the application.                                                                                                                                   |
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

The resource carries `host.name`, `os.*`, `process.pid`, `process.owner`, the executable path and runtime facts, and `service.instance.id`. They identify the instance during an incident. If you do not want them, set `OTEL_NODE_RESOURCE_DETECTORS`. It does not carry `host.id`, the machine identifier: that is a stable hardware id, the platform UUID or `/etc/machine-id`, and it is dropped unless you set `unsafe.exportHostId`.

### How this is verified

The packed tarball is installed and run with real `node --import` processes, in a CommonJS application and a native-ESM application, against a local OTLP receiver and a fake Redis. A real HTTP request carries a planted query secret and a real `EVAL` carries a planted argument; both are absent from the whole exported body, while the HTTP spans and the Redis command name are present. Negative controls (no loader hook, no preload, a preload loaded after `ioredis`, `OTEL_SDK_DISABLED=true`) export no such span, so the checks can fail. The span-end layer works on attributes, so it applies to spans from any instrumentation; an instrumentation the proofs do not exercise is not proven individually.

What is **not** redacted is listed flat in [What This Library Does NOT Do](#-what-this-library-does-not-do). To report a vulnerability, follow [SECURITY.md](./SECURITY.md).

---

## 🛡️ Security Table

| Layer                | Implementation                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Query redaction      | `url.query` is replaced by `[redacted]` and the query is cut from `url.full`, `http.url` and `http.target` as each span ends, for any instrumentation                                                                                                   |
| Outgoing URLs        | The HTTP instrumentation redacts a credential-parameter list (`token`, `code`, `access_token`, `signature`, `X-Amz-*`, and more); hosts add names, never drop them; a test compares the list with the SDK's own, so a name the SDK adds later is caught |
| Exception text       | The input quoted by a `JSON.parse` message is removed from the span status and exception events, with no opt-out; `redactExceptionText` removes every exception message                                                                                 |
| Redis                | `db.query.text` holds the command name only, for `ioredis` and node-redis; `EVAL` and `EVALSHA` payloads, which carry `KEYS` and `ARGV`, and every key never leave the process                                                                          |
| Process command line | `process.command_args`, `process.command_line` and `process.command` are dropped from the resource, because command-line arguments are a common carrier of secrets                                                                                      |
| Host id              | `host.id`, the machine identifier (the platform UUID, or `/etc/machine-id`), is dropped from the resource; `host.name` stays                                                                                                                            |
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
| `TelemetryOptionError`          | type                                                       | The error of a refused option: an `Error` with the `code` `BYMAX_TELEMETRY_OPTION_INVALID` and the refused `option`                                           |

`ignorePaths` throws, when it is called, an error whose `code` is `BYMAX_TELEMETRY_OPTION_INVALID` and whose `option` is `ignorePaths patterns` for anything that is not an array of at most 1000 regular expressions, and the error that an unreadable list raised is its `cause`, which can hold text of the host's own value where the message never does. It copies the array by index and each pattern without its `g` and `y` flags, which would keep state between calls. Anchor the patterns at both ends, with no nested quantifiers: an unanchored one also matches routes that merely contain the word, and `/^\/(a+)+$/` took 2.5 s and 5.5 s in two runs on a 28-character path (as of 2026-11-13, not a test; the tests pin the refusal of a path over 2,048 characters), and the time grows exponentially with the length.

`TelemetryOptionError` is a type and not a class the package exports, so recognize the error by its `code` and not with `instanceof`:

```ts
import { startTelemetry, type TelemetryOptionError } from '@bymax-one/nest-telemetry'

const isOptionError = (error: unknown): error is TelemetryOptionError =>
  error instanceof Error && 'code' in error && error.code === 'BYMAX_TELEMETRY_OPTION_INVALID'

try {
  await startTelemetry({ serviceName: 'my-service' })
} catch (error) {
  if (!isOptionError(error)) throw error
  console.error(`The ${error.option} option was refused`)
}
```

### Register: `@bymax-one/nest-telemetry/register`

No exports. `node --import @bymax-one/nest-telemetry/register` registers the loader hook, starts the SDK from the environment variables and flushes on a natural exit. It emits the warning codes in [The preload](#the-preload).

### Nest: `@bymax-one/nest-telemetry/nest`

| Export                           | Kind     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TelemetryModule`                | module   | Global; registers `TelemetryShutdownHook`. List it first in the application module's imports                                                                                                                                                                                                                                                                                                                             |
| `TelemetryShutdownHook`          | provider | `OnApplicationShutdown`: awaits `shutdownTelemetry()`; a refused flush is reported and never rejects                                                                                                                                                                                                                                                                                                                     |
| `TELEMETRY_LOGGER`               | token    | Optional provider with an `errorStructured(logKey, error)` method for a failed flush and a shutdown that hit its deadline, and an optional `warnStructured(logKey, message, userId, metadata)` for a failed export. Without it, a failed flush goes to the Nest logger as the [log event](#log-events) `TELEMETRY_FLUSH_FAILED`. The message and the stack are left out, because they can carry the collector's endpoint |
| `TELEMETRY_FLUSH_FAILED_KEY`     | constant | The stable key, `TRACING_FLUSH_FAILED`, under which a failed flush is reported                                                                                                                                                                                                                                                                                                                                           |
| `TELEMETRY_SHUTDOWN_TIMEOUT_KEY` | constant | The stable key, `TRACING_SHUTDOWN_TIMEOUT`, under which a shutdown that hit `shutdownTimeoutMs` is reported                                                                                                                                                                                                                                                                                                              |
| `TELEMETRY_EXPORT_FAILED_KEY`    | constant | The stable key, `TRACING_EXPORT_FAILED`, under which a failed span export is reported, with the exporter kind and the error code as metadata                                                                                                                                                                                                                                                                             |
| `ITelemetryErrorLogger`          | type     | The shape `TELEMETRY_LOGGER` provides: `errorStructured(logKey, error)` and an optional `warnStructured`                                                                                                                                                                                                                                                                                                                 |

**A logger that throws or rejects.** The hook's job is to keep shutdown from failing, so every way it reports is guarded. A logger that throws synchronously, whether it is a `TELEMETRY_LOGGER` or the logger the application installed with `Logger.overrideLogger` or `app.useLogger()`, is absorbed, and the shutdown still resolves. A promise that a `TELEMETRY_LOGGER` method returns is not awaited, and its rejection is absorbed; the entry the logger did not take goes to the channel that needs no logger, the Nest logger for a failed flush and a process warning for a shutdown timeout or a failed export. Nest does not do the same for the logger it routes through: an asynchronous `error` method installed with `overrideLogger` or `app.useLogger()` that rejects is not caught by Nest or by this library, and Node reports it as an unhandled rejection, which ends the process by default. Write a logger for Nest so that `error` never rejects.

### Observability: `@bymax-one/nest-telemetry/observability`

| Export                        | Kind     | Purpose                                                                                                                                                      |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TelemetryMetrics`            | provider | A `@bymax-one/nest-core` metrics contributor: registers the `bymax_telemetry_span_export_failures_total` counter on the registry it is handed, with no label |
| `SPAN_EXPORT_FAILURES_METRIC` | constant | The metric name, `bymax_telemetry_span_export_failures_total`                                                                                                |

---

## 🚫 What This Library Does NOT Do

By design, the following are out of scope. The attribute names below are the ones the instrumentations recorded as of 2026-11-13; only the mysql2 behaviour has a canary in the proofs, so check the others against the versions you install:

- ❌ **Redact secrets in the URL path** — only the query string is removed. A path such as `/reset/<token>` is exported as it is
- ❌ **Redact SQL text with inline literals** — database instrumentations record the statement, and values written into it are exported. A value bound to a placeholder is not recorded by `instrumentation-mysql2` 0.71, measured with mysql2 2.3.3, 3.0.0, 3.9.0 and 3.24.6; a canary in the proofs fails if that stops being true
- ❌ **Redact exception messages by default** — only the input a `JSON.parse` message quotes is removed. Every other message, the text of database driver errors included, is exported as recorded unless [`redactExceptionText`](#exception-text) is on
- ❌ **Redact the memcached key** — `db.memcached.key` is recorded on every memcached span
- ❌ **Redact an SNS phone number** — a publish to a `PhoneNumber` records the number as the destination name
- ❌ **Redact the Kafka message key** — `messaging.kafka.message.key` is recorded on producer and consumer spans
- ❌ **Redact gRPC error messages** — `grpc.error_message` is recorded when a call fails
- ❌ **Stop the OpenAI instrumentation from capturing prompts** — it reads `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` itself, and when that is set, message content is recorded
- ❌ **Redact span names your own code builds from raw URLs**
- ❌ **Redact baggage**
- ❌ **Redact request and response bodies, or HTTP headers** — they are not captured by default, and they are not redacted if you enable capturing them
- ❌ **Redact attributes your own code sets**
- ❌ **Redact log records forwarded through `OTEL_LOGS_EXPORTER`** — the library redacts spans, and a log record is exported as the logger produced it, so redact in the logger. Measured as of 2026-11-13, in a run that is not part of this repository, with `@bymax-one/nest-logger` 1.4.16, which redacts before it hands the record over: a password and a nested token never reached the collector, and the `[REDACTED]` marker did. A plain pino logger with no redaction exported its password
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
