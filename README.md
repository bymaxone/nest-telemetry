# @bymax-one/nest-telemetry

OpenTelemetry tracing for NestJS 11 and plain Node. It starts the SDK before your application loads, redacts secrets from spans by default (URL query strings, Redis arguments, the process command line), keeps probe paths out of your traces and flushes on shutdown.

Every OpenTelemetry package is an optional peer dependency, and a boot with telemetry disabled loads none of them. See [Security and threat model](#security-and-threat-model) for what is redacted and what is not.

## Support matrix

| Part                     | Supported                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Node.js                  | 24 or newer                                                                                                            |
| NestJS (`./nest` only)   | 11                                                                                                                     |
| Applications             | CommonJS and native ES modules                                                                                         |
| OpenTelemetry generation | `sdk-node` and exporters 0.301.x, `sdk-trace` and `resources` 3.1.x, `api` 1.10.x, `auto-instrumentations-node` 0.83.x |

The OpenTelemetry generation is the one the tests run against; how a range is widened, and how the next release is checked, is in [Peer dependencies and OpenTelemetry versions](#peer-dependencies-and-opentelemetry-versions).

**Native ES modules.** Auto-instrumentation patches CommonJS modules as they load, and native ES modules only through a loader hook. The preload registers that hook, and it needs the optional peer `@opentelemetry/instrumentation`. Without that package, a native-ESM application gets no auto-instrumentation at all; CommonJS code is unaffected, and the start warns (`BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE`) so the gap is not silent. Measured on real consumers: an ESM application with the SDK started and no hook exported no HTTP span; with the hook it did.

## Why this exists

- **Zero cost when disabled.** A boot with `OTEL_SDK_DISABLED=true` registers no loader hook and loads no OpenTelemetry package, `@opentelemetry/api` included. This is checked from the packed tarball in ESM and CommonJS, with a positive control that proves the check can fail.
- **Secret-safe by default.** Span data is a leak surface: a magic-link token in a query string, a Redis `EVAL` payload, a secret in a command line. Each is redacted by default, and turning one off takes an explicit option that also emits a warning. There is no environment variable that turns redaction off.
- **Preload ordering done right.** The SDK has to start before the libraries it instruments are loaded, and starting it from `main.ts` is too late. A `node --import` preload runs first, and this package ships one that reads only the standard `OTEL_*` variables.

## Quickstart: NestJS

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

Things to know before you rely on it:

1. **Traces only, by default.** Metrics and logs stay off unless `OTEL_METRICS_EXPORTER` or `OTEL_LOGS_EXPORTER` names an exporter. This departs from the OpenTelemetry default, which exports both through OTLP, and it does so on purpose: otherwise a host that already ships metrics and logs another way would send them twice.
2. **Name your service.** With neither `OTEL_SERVICE_NAME` nor a `serviceName` option, the start warns once (`BYMAX_TELEMETRY_SERVICE_NAME_MISSING`) and spans are exported as `unknown_service:node`, which groups unrelated services under one name. The start is never refused.
3. **Signals.** The preload flushes when the process runs out of work. It installs no signal handler, because a handler in the preload would race the application's own shutdown. In Nest, call `app.enableShutdownHooks()` so `SIGTERM` closes the application, and the module flushes the SDK. In plain Node, call `shutdownTelemetry()` yourself.

## Quickstart: plain Node

The SDK part never imports `@nestjs/*`. Start it from your own preload, or from the first lines of your entry point if nothing instrumented has been imported yet:

```ts
import { ignorePaths, startTelemetry } from '@bymax-one/nest-telemetry'

const telemetry = await startTelemetry({
  serviceName: 'billing',
  serviceVersion: '1.4.2',
  ignoreIncomingRequest: ignorePaths([/^\/health\/(live|ready)\/?$/, /^\/metrics\/?$/])
})

process.once('SIGTERM', () => {
  void telemetry.shutdown()
})
```

`startTelemetry` resolves to a handle with `enabled` and `shutdown()`. Starting twice returns the handle already running, including across two copies of the module (an ES-module preload and a CommonJS application share the handle through `globalThis`).

## Using with the bymax-one template

If you build on the bymax-one backend template, this package is its tracing library, selected by default and optional: a derivation that does not select it deletes the dependency and its wiring together. The template keeps the policy and passes it in:

- its own `OTEL_ENABLED` switch becomes `enabled`;
- its probe paths become `ignoreIncomingRequest: ignorePaths(...)`;
- its service name and version variables become `serviceName` and `serviceVersion`, with `OTEL_SERVICE_NAME` still overriding;
- `TELEMETRY_LOGGER` is bound to its structured logger, so a failed flush keeps arriving under the key `TRACING_FLUSH_FAILED` that alerts already match.

Some behaviours differ from the code the template used before: the service name has no library default (the template passes its own), the handle is shared under a `Symbol.for` key instead of a string, and turning a redaction off now warns.

```ts
import { Module } from '@nestjs/common'

import { TELEMETRY_LOGGER, TelemetryModule } from '@bymax-one/nest-telemetry/nest'

class AppLogger {
  errorStructured(logKey: string, error: Error): void {
    console.error(logKey, error.message)
  }
}

@Module({
  imports: [TelemetryModule],
  providers: [AppLogger, { provide: TELEMETRY_LOGGER, useExisting: AppLogger }]
})
export class AppModule {}
```

## How it behaves

### Enabling and disabling

The SDK starts unless something says no, and `OTEL_SDK_DISABLED=true` always says no, whatever the code passes. `enabled: false` also disables it. `OTEL_SERVICE_NAME` overrides the `serviceName` option, because the operator's standard variable should win over what the code chose. Blank values count as absent.

### The preload

`./register` is for `node --import`. It registers the loader hook, starts the SDK from the standard variables and flushes on a natural exit. It is ES-module only in substance: requiring it from CommonJS throws and names `node --import`, because starting the SDK is asynchronous and a `--require` preload cannot wait for it, which would let the application load first, unnoticed.

Tracing never takes down a boot. Each failure the preload can meet is a warning, and the application still starts:

| Code                                        | Meaning                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `BYMAX_TELEMETRY_START_FAILED`              | The SDK could not start (a peer is missing, or the SDK threw). Tracing is off. |
| `BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE`      | The loader hook could not be registered. Native-ESM code is not instrumented.  |
| `BYMAX_TELEMETRY_SERVICE_NAME_MISSING`      | No service name is set; spans use `unknown_service:node`.                      |
| `BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED` | A redaction was turned off through an `unsafe` option.                         |

The programmatic `startTelemetry` keeps its rejection when the SDK cannot start, for callers that want it.

### What is traced

- **Load order matters only for modules your application loads itself.** The core `http` module is patched even when the preload runs after it. A client such as `ioredis` is patched only if the preload ran before the application required it. Measured: an application that required `ioredis` first exported no `ioredis` span.
- **Redis commands are traced only under an active span.** The `ioredis` instrumentation defaults to `requireParentSpan: true`, so a command issued outside any request produces no span. Commands inside a request handler do.
- **`fs` instrumentation is off by default**, because it floods traces with disk activity that has no context. Turn it on with `instrumentations.fs`.

### Flushing

Awaiting `shutdown()` or `shutdownTelemetry()` means the spans were exported, whoever started the flush: overlapping callers wait for the same flush, and a shutdown that arrives while the SDK is still starting waits for the start and then stops what it built. A flush the collector refuses is reported, never thrown into your shutdown path, by the Nest module; the programmatic functions reject, so their caller decides.

## Configuration reference

### `startTelemetry(options)`

| Option                                 | Default                      | What it does                                                                                                                        |
| -------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                              | `true`                       | `false` never starts the SDK. `OTEL_SDK_DISABLED=true` disables it regardless.                                                      |
| `serviceName`                          | `unknown_service:node`       | The service name. `OTEL_SERVICE_NAME` overrides it.                                                                                 |
| `serviceVersion`                       | none                         | The service version.                                                                                                                |
| `ignoreIncomingRequest`                | none                         | Returns `true` for an incoming request that must produce no server span. `ignorePaths(patterns)` builds one from anchored patterns. |
| `instrumentations.fs`                  | `false`                      | File-system instrumentation.                                                                                                        |
| `instrumentations.sendLogs`            | follows `OTEL_LOGS_EXPORTER` | Whether pino's records are forwarded to the OpenTelemetry logs pipeline.                                                            |
| `instrumentations.overrides`           | none                         | Per-instrumentation configuration, merged over the library's. Redaction settings cannot be replaced here.                           |
| `extraRedactedQueryParams`             | none                         | Names added to the list redacted from outgoing request URLs. They add to the defaults and never replace them.                       |
| `unsafe.disableUrlRedaction`           | off                          | Keeps `url.query`, `url.full`, `http.url` and `http.target` as recorded. Literal `true`. Warns.                                     |
| `unsafe.disableRedisArgumentRedaction` | off                          | Keeps Redis command arguments in `db.query.text`. Literal `true`. Warns.                                                            |
| `unsafe.exportProcessCommandArgs`      | off                          | Keeps `process.command_args` and `process.command_line` in the resource. Literal `true`. Warns.                                     |
| `env`                                  | the process environment      | The environment the library reads. The OpenTelemetry SDK itself always reads the process environment.                               |

### Environment variables

The library reads these in one source file, and a test fails if any other file names `process.env`:

| Variable                                                                                                          | Effect                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `OTEL_SDK_DISABLED`                                                                                               | `true` (any letter case) disables the SDK.                                                                           |
| `OTEL_SERVICE_NAME`                                                                                               | Service name; overrides the option.                                                                                  |
| `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`                                                                     | Metrics and logs are exported only when these name an exporter.                                                      |
| `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_EXPORT_TIMEOUT`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | Mapped onto the batch span processor the library passes; the SDK applies them only to one it builds itself.          |
| `OTEL_NODE_RESOURCE_DETECTORS`                                                                                    | Selects resource detectors, under the specification's names (`service`, `host`, `process`) and the SDK's older ones. |

The OpenTelemetry SDK reads these itself, and the library never touches them: `OTEL_EXPORTER_OTLP_*`, `OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG`, `OTEL_RESOURCE_ATTRIBUTES`.

### Exports

| Subpath      | Exports                                                                                              |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| `.`          | `startTelemetry`, `shutdownTelemetry`, `ignorePaths`, `DEFAULT_REDACTED_QUERY_PARAMS`, and the types |
| `./register` | nothing: importing it runs the preload                                                               |
| `./nest`     | `TelemetryModule`, `TelemetryShutdownHook`, `TELEMETRY_LOGGER`, `TELEMETRY_FLUSH_FAILED_KEY`         |

## Security and threat model

A span can carry whatever an instrumentation or your code records on it. This package redacts what it can know is dangerous, by default, and says plainly what it does not cover.

### Redacted by default

| Layer                 | What it removes                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Span end, every span  | `url.query` is replaced by `[redacted]`, and the query is cut from `url.full`, `http.url` and `http.target`. It runs on spans from any instrumentation, not only HTTP.                                                                                                                     |
| Outgoing request URLs | The HTTP instrumentation redacts a list of credential-bearing parameters (`token`, `code`, `access_token`, `signature`, `X-Amz-*`, and more). A host can add names, not drop them. The list is compared in a test with the SDK's own default list, so a name the SDK adds later is caught. |
| Redis                 | `db.query.text` holds the command name only. `EVAL` and `EVALSHA` payloads, which carry `KEYS` and `ARGV`, never leave the process.                                                                                                                                                        |
| Resource              | `process.command_args` and `process.command_line` are left out, because command-line arguments are a common carrier of secrets.                                                                                                                                                            |

Each layer except the outgoing request URL list has one off switch, an `unsafe` option set to the literal `true`, and each one emits a process warning of type `SecurityWarning` with the code `BYMAX_TELEMETRY_UNSAFE_REDACTION_DISABLED`. `instrumentations.overrides` cannot undo a layer: a list of parameters you supply is added to the library's, and the Redis serializer stays the library's.

### Not covered

These are not redacted, and you should treat them as yours to handle:

- **Secrets in the URL path.** Only the query string is removed. A path such as `/reset/<token>` is exported as it is.
- **SQL text with inline literals.** Database instrumentations record the statement; values written into it are exported.
- **`exception.message` in span events.** An exception's message is exported as recorded.
- **Span names your own code builds from raw URLs.**
- **Baggage.**
- **Request and response bodies, and HTTP headers.** They are not captured by default, and they are not redacted if you enable capturing them.
- **Attributes your own code sets.**

### Exported on purpose

The resource carries `host.name`, `os.*`, `process.pid`, `process.owner`, the executable path and runtime facts, and `service.instance.id`. They identify the instance during an incident. If you do not want them, set `OTEL_NODE_RESOURCE_DETECTORS`.

### How this is verified

The packed tarball is installed and run with real `node --import` processes, in a CommonJS application and a native-ESM application, against a local OTLP receiver and a fake Redis. A real HTTP request carries a planted query secret and a real `EVAL` carries a planted argument; both are absent from the whole exported body, while the HTTP spans and the Redis command name are present. Negative controls (no loader hook, no preload, a preload loaded after `ioredis`, `OTEL_SDK_DISABLED=true`) export no such span, so the checks can fail. The proof covers the HTTP and `ioredis` instrumentations; the span-end layer works on attributes, so it applies to spans from other instrumentations too, but those are not each proven individually.

To report a vulnerability, follow [SECURITY.md](./SECURITY.md).

## Peer dependencies and OpenTelemetry versions

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

## Comparison with wiring the SDK by hand

| You would otherwise write and maintain                                   | This package                                                                            |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| A preload that starts the SDK before the application loads               | `node --import @bymax-one/nest-telemetry/register`, reading the standard variables      |
| The loader hook for native-ESM applications                              | Registered by the preload, with a warning when its peer is missing                      |
| Query-string redaction for every span, and the credential parameter list | On by default; the list is checked against the SDK's own                                |
| A Redis serializer that keeps `EVAL` payloads out of spans               | On by default                                                                           |
| Keeping the command line out of the resource                             | On by default                                                                           |
| Mapping `OTEL_BSP_*` onto the batch processor you pass                   | Done                                                                                    |
| Sharing the SDK between a preload and the application                    | A handle under a `Symbol.for` key, one SDK even across module copies                    |
| Flushing on shutdown without racing the framework's own shutdown         | `TelemetryModule` flushes through Nest's hook; a failed flush is reported, never thrown |
| Making sure a telemetry failure cannot stop the host from booting        | Each failure the preload can meet is a warning                                          |

What it does not do for you: choose a sampler, run a collector, or decide your span names. Those stay standard OpenTelemetry configuration.

## Troubleshooting

| You see                                                  | Look at                                                                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| No spans at all                                          | `OTEL_SDK_DISABLED`; that the application was started with `--import`; `OTEL_EXPORTER_OTLP_ENDPOINT`; the start warnings. |
| Spans from a CommonJS app but none from a native-ESM app | `BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE`: install `@opentelemetry/instrumentation`.                                         |
| Spans arrive but carry no service name                   | `BYMAX_TELEMETRY_SERVICE_NAME_MISSING`: set `OTEL_SERVICE_NAME` or the `serviceName` option.                              |
| `BYMAX_TELEMETRY_START_FAILED`                           | The warning names the cause, usually an OpenTelemetry peer that is not installed.                                         |
| HTTP spans but no Redis spans                            | Commands are traced under an active span only, and `ioredis` must be loaded after the preload.                            |
| Metrics or logs missing                                  | They are off unless `OTEL_METRICS_EXPORTER` or `OTEL_LOGS_EXPORTER` names an exporter.                                    |
| The last spans are lost on `SIGTERM`                     | Call `app.enableShutdownHooks()` in Nest, or `shutdownTelemetry()` in your signal handler.                                |
| A query string still appears in a span                   | It is on an attribute other than `url.query`, `url.full`, `http.url` or `http.target`: see [Not covered](#not-covered).   |

## Compatibility and versioning

This package does not promise strict semantic versioning. Each release in the [CHANGELOG](./CHANGELOG.md) says what changed and what to do about it, and the version number alone is not the compatibility information. See [CONTRIBUTING.md](./CONTRIBUTING.md) to contribute.

## License

[MIT](./LICENSE)
