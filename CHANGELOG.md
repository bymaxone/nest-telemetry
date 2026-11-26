# Changelog

All notable changes to `@bymax-one/nest-telemetry` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The `release.yml` workflow extracts the section matching the pushed `vX.Y.Z` tag
as the GitHub Release body, so each released version needs a matching `## [X.Y.Z]`
heading here.

## [1.0.14] - 2026-11-26

### Changed

- The entry the Nest logger gets for a failed flush is an object, `{ event: 'TELEMETRY_FLUSH_FAILED', message, code }`,
  where it was a string. `message` is the same text, still starting with `TRACING_FLUSH_FAILED`. Apply: an alert
  that matches the text keeps matching where the logger writes `message`; a custom Nest logger that assumes a
  string must accept an object. `@bymax-one/nest-logger` before 1.4.23 writes an object message as
  `[object Object]`, so update it first. The `TELEMETRY_LOGGER` calls are unchanged.
- **An `ignoreIncomingRequest` that returns a promise no longer ignores the request.** The HTTP instrumentation
  read the promise itself as `true`, so an `async` hook dropped every server span whatever it resolved with, and
  one that rejected ended the process by default. A promise or another thenable now counts as "not ignored", its
  rejection is absorbed, and the first one emits the `BYMAX_TELEMETRY_IGNORE_HOOK_ASYNC` warning. A synchronous
  hook behaves as before.

### Added

- **The type of the option error, `TelemetryOptionError`.** It is the error `startTelemetry` rejects with, and
  `ignorePaths` throws, for an option of the wrong kind: an `Error` whose `code` is
  `BYMAX_TELEMETRY_OPTION_INVALID` and whose `option` is a string. It is a type only, so nothing changes at run
  time and there is no class to use with `instanceof`: test the `code`.

### Apply to a derived backend

This type needs no change. A cast or a local interface written for this error can be replaced with the exported type.

An `ignoreIncomingRequest` that is `async`, or that returns a promise, must be made synchronous: until then the
requests it was meant to ignore are traced. A synchronous hook needs no change.

## [1.0.13] - 2026-11-24

### Fixed

- **A built-in that code replaces after the library loaded can no longer lose a warning or a host option.** The
  callback of a failed export looked its built-ins up when it ran, so a replaced one made it throw before the caller
  was told and the `BYMAX_TELEMETRY_EXPORT_FAILED` warning was lost. The settling of the start options did the same,
  so a replaced one dropped host options such as `enabled: false` in silence. Both paths now call the built-ins the
  library read once when it loaded.
- **A built-in that the library's own checks rely on, replaced after it loaded, now counts as a pollution.** The
  check of the process compared only `Object.prototype` with a fresh realm. It now also compares the members of the
  built-ins the library calls: one that is replaced, deleted or swapped for a function of another
  realm counts one, so the start answers with the disabled handle and an export drops its batch, and a check that
  cannot read them counts one rather than zero. What tracing agents and context managers wrap by
  design, such as timers, `http`, `fetch` and the `then` of `Promise.prototype`, is not compared, and no decision to drop or to send rests on them, the loads of the packages aside (see the known limit on `import()`). The warning says that `Object.prototype` or a
  built-in was changed, with a count and never a name.
- **A map or an entry of `instrumentations.overrides` whose settings sit on a prototype is refused.**
  The copy read own keys only, so `enabled: false` held by a parent object (`Object.create({ enabled: false })`) was dropped in silence, and the instrumentation stayed on. The root prototype of the realm, where a
  pollution is planted, and the methods of a class are not a setting, but a getter or a setter of a class is, since it is not enumerable and the copy would drop what it answers. The start fails with `BYMAX_TELEMETRY_OPTION_INVALID`.
- **The warning for a batch dropped by the pollution guard says why.** It told the host to check that the collector
  was reachable, though the collector was never contacted. The dropped batch now fails with the code
  `BYMAX_TELEMETRY_REALM_POLLUTED`, and the warning names the change.
- **An `OTEL_*` value of a host `env` object that is not a string is ignored.** Each variable the library reads
  went straight to `.trim()`, `.split()` or a number conversion, so `env: { OTEL_SERVICE_NAME: 5 }` threw a
  `TypeError` at start, and a number or a boolean was read as if it were the text it converts to. A value that is not
  a string is now read as no variable, for every variable the library reads. The process environment never holds
  one, so nothing changes for it.
- **The Lambda start time is read while the instrumentation is built.** The AWS Lambda instrumentation reads
  `lambdaStartTime` as well as `lambdaHandler` when it is built, so it is an own undefined key like the handler name.
- **The refusal for too many values in a nested setting says so.** The limit of 10,000 objects and lists in one
  setting had the message of the limit of 16 levels; it now says `at most 10,000 objects and lists in all`.
- **The start and the export no longer let a forged promise result decide.** The start awaited the packages
  through `Promise.all` and an `await`, and a guarded export awaited the provider answer and the send. A
  `Promise.all` replaced after load, a `then` on `Object.prototype` that erases itself after one read, or a replaced
  `then` with a constructor that is put back could hand back a forged `NodeSDK` or forged headers while the checks
  passed. The decisions now wait for a promise of the library with a native `await` after it took an own `constructor`, wait for a promise of a host without writing to it, settle through a native promise from the
  engine's own constructor, and check the process immediately before they settle. A `then` on
  `Array.prototype` or `Function.prototype`, and a changed `constructor` of `Promise.prototype`, which every `then`
  reads for a species, count as a pollution like one on `Object.prototype`; a promise the library made gets its own
  `constructor`, and a promise a host made is never written to. The handle of a started SDK has no prototype, and
  the check is the last thing before a promise of the library resolves with a handle or a send result. A refusal
  of a start at boot answers with the disabled handle, and a refusal of a send fails the export. A wait on a promise
  of a host that cannot be consumed, because its `constructor` was replaced, is refused instead of going on: a start, a
  `shutdown` and `shutdownTelemetry` then reject with `BYMAX_TELEMETRY_REALM_POLLUTED`. A boot that finds the process
  polluted after the SDK started stops that SDK, warns with the same code and answers with the disabled handle. The
  handles the library returns are frozen. The loads of the packages are not part of this claim: see the known limit
  on `import()`.
- **The preload waits for the start on a promise of its own.** A `constructor` and a `then` planted for a single read
  while the SDK starts could forge the handle the preload awaited and skip the registration of the flush on exit.

### Documentation

- **The README states what the pollution guard does not cover**, so a host knows where it stops.
- **The README says the limits on a nested override setting are new in 1.0.12**, so a host that nested more than that finds the refusal documented.
- **The docs state the threat model.** `SECURITY.md` says that code running in the same process is trusted, as in
  Node, and that the guards are best-effort hardening and not a security boundary.

### Known limits

- The packages are loaded by `import()`, and Node's module loader fills those promises through the live
  `Promise.prototype.then`. A host that replaces `then`, swaps a module namespace and puts `then` back can have a
  package of its own built; module resolution belongs to the host, which can also replace a module through loader
  hooks or `require.cache`, so the library does not claim to close this route.
- The check compares the engine's `Promise` with a fresh realm's, and the library takes it from the engine, but a
  host that changes `Promise.prototype.constructor` to something that reads like the engine's own `Promise` before
  the library loads is not told apart.
- A host provider that resolves a plain object reads a `then` planted on `Object.prototype` itself, before the
  library sees the value; the library cannot close that from its side.
- The OpenTelemetry and OTLP exporter internals read statics and `then` on their own, outside the decisions above.
- A `then` that is planted and erased again between the check at entry and the settling is not seen.
- When a host's own promise cannot be consumed, because its `constructor` was replaced by something that throws or
  names a `Symbol.species` that throws, the batch or answer is refused, but that promise's own rejection, if it has
  one, stays unhandled: the library never writes to a promise a host made, so it cannot take the reaction first.
- A `Promise[Symbol.species]` getter that erases itself inside a third-party call is not observable: the realm checks
  compare the accessor before and after, and a dependency's own `then` reads it in between.
- When `Promise.prototype.constructor` was deleted before the library loaded, the start is refused as polluted, and the
  promise it answers with comes from a fresh realm: `instanceof Promise` is `false` for it, while `await` and `.then`
  work as usual. This happens only on that refused path.
- A promise of a dependency that the library waits for, such as the answer of a transport, takes a `constructor` of
  its own first; a transport that already holds a read-only `constructor` on it cannot be given one, and the wait is judged
  on the `constructor` it holds.
- The slots on `globalThis` under which state is shared between copies of the library are writable by the host; a host that overwrites them changes what a later call finds.

### Apply to a derived backend

Nothing to change. A setting nested in an override beyond those limits fails at start with
`BYMAX_TELEMETRY_OPTION_INVALID`, as it does since 1.0.12. A host `env` object that held a number, a boolean or an object for one of the `OTEL_*` names now
reads that variable as unset instead of throwing or converting it. An `instrumentations.overrides` map or entry whose
settings sit on a prototype now fails at start instead of losing them.

## [1.0.12] - 2026-11-21

### Fixed

- **A flag that only the root prototype of the realm holds is no longer read as the host's.** `unsafe` flags and
  `instrumentations.fs`, `sendLogs` and `overrides` were read through the whole prototype chain, so a polluted
  `Object.prototype` could switch a redaction off or the export of log records on without the host asking. Those
  keys are now read from the object, a class instance or a class prototype, and never from the root prototype alone.

- **A group of options that only the root prototype of the realm holds is no longer read either.** The options of the
  call were read by property access, so a polluted `Object.prototype.unsafe` switched the redaction off, and
  `Object.prototype.instrumentations` ran a hook of its own, for a host that passed no such group. Every option of the
  call (`unsafe`, `instrumentations`, `env` and the rest) is now read with the same rule, and so is each `OTEL_*`
  variable of an environment, and the copy of the call that the start works from has no prototype, so a key the call
  did not give stays absent.

- **A name that only the root prototype of the process holds no longer decides what OpenTelemetry reads or what an
  instrumentation does.** OpenTelemetry reads its own `OTEL_*` variables from the process environment, which inherits
  from `Object.prototype`, so a planted `OTEL_EXPORTER_OTLP_*` redirected the spans or added headers and compression,
  and a planted `OTEL_SDK_DISABLED`, `OTEL_TRACES_SAMPLER`, `OTEL_SERVICE_NAME` or `OTEL_RESOURCE_ATTRIBUTES` stopped
  the export, sampled it away or renamed the service while `enabled` reported true, and a planted `http_proxy` or
  `grpc_proxy` routed a gRPC export through a proxy of the attacker's. Telemetry now refuses to run beside such a
  process: when the `Object.prototype` of the process holds a name that a fresh realm's does not (or lacks, or holds
  changed, which a name overwritten with another value is, or when a fresh realm to compare it with cannot be built), `startTelemetry` starts nothing, answers with the disabled
  handle and emits one `BYMAX_TELEMETRY_REALM_POLLUTED` warning that carries a count and never a name or a value; the
  preload does the same; and every OTLP export, including the exporters the SDK builds for metrics and logs, drops its
  batch with a failed result and no I/O while the prototype is polluted. The wrap of the export is process-wide, on the
  base class that the exporters share; the Prometheus exporter is not an OTLP exporter and reads its host and port when it
  is built, so only the checks before the SDK is built cover it. The check runs again right before the SDK is built, with no await
  between them, so a name planted while the packages load and removed before the first export is seen too. A host that extends `Object.prototype` (should.js, chai.should, a polyfill)
  cannot start telemetry. The configuration the SDK is built with has no prototype, so a planted `serviceName`,
  `sampler`, `idGenerator`, `textMapPropagator` or provider is not one of its options. The instrumentation
  settings are built with no prototype, the HTTP instrumentation gets its own undefined `headersToSpanAttributes`, and
  the configuration of every instrumentation is cut from the root prototype once it is built, so a planted
  `headersToSpanAttributes`, request hook or response hook neither records the `Authorization` header nor runs, and a
  planted key named after an instrumentation does not override the host's `fs` or `sendLogs`. An instrumentation the
  host did not configure also gets an entry with no prototype, so a planted `enabled` cannot switch the
  instrumentations off or override `OTEL_NODE_DISABLED_INSTRUMENTATIONS`.
  The settings an instrumentation reads while it is built (the HTTP header capture, the gRPC metadata capture, the
  AWS Lambda handler name, and the Redis settings that its two clients copy) are own keys that are
  undefined, because the configuration the instrumentation copies into an ordinary object cannot be cut from the
  root prototype until it is built.
  The same holds one level down: a plain object that the host nests inside an override setting (for
  example `headersToSpanAttributes: { server: {} }`) is copied with no prototype, so a planted `requestHeaders` is not
  found under it, and a list is copied member by member; the copy is refused beyond 16 levels below the setting, 10,000 objects and lists or 1000 entries to a list or an object.

- **The check no longer looks a built-in up when it runs.** The pollution check and the wrap of the export called
  `Object.getOwnPropertyDescriptors`, `Object.hasOwn`, `Reflect.ownKeys`, `Set.prototype.add`, the iterators of arrays
  and sets, `Function.prototype.call` and the `Object` and `Error` globals as they were when they ran, so code that
  replaced one of them after the library loaded blinded the check. Everything the check and the wrap call is now read
  once when the library loads, and they walk arrays by index and keep their names on an object with no prototype. A
  test replaces, in a real process, every function and getter of the global objects in turn and expects the refusal.
  The check also runs before every request attempt, not only when an export starts: an attempt waits for the modules
  it loads, and a retry waits for a back-off, and a name planted in that time was read by the request. The
  transport of each exporter is wrapped when its first export is made, so an attempt is refused before it starts and
  again just before it reads its headers, metadata or credentials (HTTP and gRPC) and once more when a provider has answered, with no I/O and no retry. A promise that a provider returned and the guard drops is given a rejection handler, so a refusal never becomes an unhandled rejection. A custom exporter that does not keep its transport in a `_delegate`, and a transport swapped while an export is already under way, are not covered. A test
  plants a name during the first load and during the back-off of a retried 503 and expects no request; the same
  flows send without a plant.
  Every warning of the library also carries an own, empty `detail`, so a `detail` planted on `Object.prototype` is
  not printed, and a warning Node cannot build is dropped instead of thrown.

- **An option that only a prototype with no prototype holds fails the start instead of being dropped.** A host
  option chain that ends in a parent object with no prototype (`Object.create(parent)` with the value on `parent`) had
  its values ignored in silence, so `serviceName`, `ignoreIncomingRequest` or `extraRedactedQueryParams` could go
  missing without a word. The start now fails with `BYMAX_TELEMETRY_OPTION_INVALID` naming the option, so the host
  puts it on the options object or on a class; the root prototype of this realm, where a pollution is planted, is
  still ignored.

- **An option that must be an object is refused when it has a brand Node tells apart, or a chain of prototypes that
  is longer than 100 or never ends.** The list of refused kinds is now a set of brand predicates of `util.types`
  (so a `WeakMap`, a typed array, an `Error` and a generator object are refused too), and a plain object, an
  object with no prototype, a class instance whose chain ends within 100 prototypes and the environment object are
  read. A `Proxy` whose `getPrototypeOf` answers itself was accepted before and is refused now. No property of a
  prototype is read to tell the end of a chain from data, so an overwritten `constructor` on the root, or an object
  of another realm, changes nothing. A `Proxy` that has only a `get` trap is read through what it answers, and the
  options object of the call itself is refused when it is a function, an array or any other value that is not an
  object of settings.

### Documentation

- **The README and the declarations of `ignorePaths` say what it throws** (when it is called, with the code, the
  option name `ignorePaths patterns`, the cause and the cap of 1000) and that the `cause` can hold text of the
  host's value.
- **The README says which prototype is ignored** and that a field of a class instance and a getter of its class
  are still read.

### Apply to a derived backend

Nothing to change for options written as an object literal or as a class. A host that extends `Object.prototype` can no longer start telemetry, and an option held only by a parent object with no prototype now fails the start. A configuration that relied on an option
or a flag set on `Object.prototype` (a pollution, not an option) now reads it as unset. An object option of a kind
that `util.types` reports (a `WeakMap`, a typed array, an `Error`, a generator object), or whose chain of prototypes
is longer than 100 or never ends, now fails at start with `BYMAX_TELEMETRY_OPTION_INVALID`.

## [1.0.11] - 2026-11-21

### Fixed

- **`ignorePaths` copies its patterns by index and refuses what is not a list of regular expressions.** It copied
  with `patterns.map`, so an array subclass whose `map` returns nothing ignored no path, and an object with a
  `source` and `flags` was accepted as an expression. It now reads the length once (at most 1000), each index once
  and each entry through `util.types.isRegExp`, and throws `BYMAX_TELEMETRY_OPTION_INVALID` for anything else, an expression whose own `flags` cannot be built, or a list that throws while it is read, included (the error it raised is the `cause`).
- **An option that must be an object refuses a `Map`, a `Set`, a `Date`, a `RegExp`, a `Promise` and a boxed
  primitive.** They were accepted and read as an empty object; they are refused as the wrong kind, by the kind
  Node reports and not by the prototype, so a class instance and a `Proxy` of a plain object are still read.

### Documentation

- **The README says that a `__proto__` key is refused as the name of an instrumentation too**, and that an entry
  or a setting that is `null` or `undefined` is dropped and not refused.

### Apply to a derived backend

A `Map`, `Set`, `Date`, `RegExp`, `Promise` or boxed primitive passed for `unsafe`, `instrumentations`,
`instrumentations.overrides` or `env` now fails at start with `BYMAX_TELEMETRY_OPTION_INVALID`. `ignorePaths` throws
the same code when it is called, not at start, for an argument that is not an array of at most 1000 regular expressions, a list that reads
empty while it holds index keys, a pattern whose flags cannot be built, and a list whose own read throws (the
error it raised is the `cause`). Pass a plain object, and a real array of `RegExp`. Nothing else changes.

## [1.0.10] - 2026-11-21

### Fixed

- **An option of the wrong kind is refused, and no longer read as something it is not.** The string `'false'`, a
  number or an object for `instrumentations.sendLogs` was truthy and turned the export of log records on, which
  sends data off the host; the string `'true'` for an `unsafe` flag was dropped without a word; a string for
  `extraRedactedQueryParams` was spread into its characters and a number threw a `TypeError` out of the start.
  `startTelemetry` now rejects with an error whose `code` is `BYMAX_TELEMETRY_OPTION_INVALID` and whose `option`
  names the option, before any SDK is started. `shutdownTimeoutMs` keeps its documented fallback.
- **The settings of an `instrumentations.overrides` entry that decide what leaves the host are checked too.** An
  override was spread over the library's configuration unchecked, so `{ disableLogSending: 0 }` for the pino
  instrumentation turned log sending on and a non-boolean `enabled` replaced the one the library forces. Each
  entry is now copied once; `enabled` and `disableLogSending` must be booleans, `redactedQueryParams` an array
  of strings, every setting named `...Hook` a function, an entry holds at most 1000 settings, and a `__proto__` key is refused. The error names
  `instrumentations.overrides[]` and never the instrumentation or the value.
- **Each option of a call is read once.** A getter could make a warning and the effect of the call disagree. A
  call now reads each option once, checks its kind, and works from the copy.

### Documentation

- **The README says a failed start starts no new SDK.** It said "no SDK started and no handle left", which is
  wrong for a later call that finds an SDK already running; it now says that the failed start starts no new SDK
  and that a first start leaves no handle.
- **The README lists the ranges of the peers that are not OpenTelemetry packages**, as `package.json` declares
  them, and its CPU item no longer says "that handler".

### Apply to a derived backend

A configuration that passed a value of the wrong kind used to be accepted and now fails at start with
`BYMAX_TELEMETRY_OPTION_INVALID`. Look for a string such as `'false'` in `instrumentations.sendLogs` or an `unsafe`
flag (read from an environment variable without converting it), a single string for `extraRedactedQueryParams`
(pass `['name']`), a non-boolean `enabled` or `disableLogSending`, a non-array `redactedQueryParams` or a non-function `...Hook` inside an `overrides` entry, and a list, map or entry of more than 1000 items. Nothing else changes: a plain value of
the documented kind behaves as before.

## [1.0.9] - 2026-11-20

### Fixed

- **The start reads `unsafe` and `instrumentations` once, each field once, and `ignoreIncomingRequest` once.** The
  warning about turned-off redactions, the SDK build and the instrumentation config each read `unsafe` (and its
  fields), the winston transport warning and the config each read `instrumentations`, and the config read
  `ignoreIncomingRequest` twice, so an option object with a getter, on the option or on one of its fields, could
  make a warning and the effect disagree: a first read of `{}` gave no warning while the host id, the process
  command line and the raw URL were exported. The start now copies both options into a plain object, reading each
  field once, and every step works from the copy. This replaces the per-step reads that 1.0.8 described.
- **An option that throws when read can no longer leave a started SDK without a handle.** `shutdownTimeoutMs` was
  read after the SDK had started, so a getter that threw there made the start reject while the SDK kept running
  and nothing could stop it. It is read before the start now, with the other options, and every position at which
  an operation on the options fails ends in that error with no SDK started.

### Documentation

- **The README says that the sampler ratio warning does not repeat a blank value.** It repeats the value only when
  it is not blank; a blank one is called blank.
- **1.0.7's note on a rejecting `TELEMETRY_LOGGER` is superseded.** It says a rejection is dropped silently; since
  1.0.8 the report goes to the Nest logger (a failed flush) or to a process warning (a shutdown timeout, a failed
  export), and the README's logger paragraph says so. The README also says that starting twice returns the running
  handle unless `enabled: false`, which returns a disabled one.
- **The README says what `startTelemetry` rejects with.** The error that was thrown, as it was thrown: there is no
  library error class for a start. When an option cannot be read, the start ends with that error, with no SDK
  started and no handle left.

### Apply to a derived backend

The public declarations did not change. A derived backend acts on this behaviour:

1. An options object whose `unsafe` or `instrumentations` is a getter, or whose fields are getters (a computed or lazy
   option), is now read once, each field once, for the whole start, so the redaction warning and the redaction the
   SDK applies come from the same values. An option that answers differently on each read no longer splits them.

## [1.0.8] - 2026-11-20

### Fixed

- **The sampler ratio warning escapes direction and invisible characters in the value it repeats.** It quoted the
  operator's `OTEL_TRACES_SAMPLER_ARG` with `JSON.stringify`, which leaves the control characters from the delete
  character to the C1 range, every format character (the soft hyphen, the zero-width characters, the direction
  marks and overrides, the invisible operators and the byte order mark) and the line and paragraph separators as
  they are, so a value could reorder or hide the warning line. They are now written as `\uXXXX`, or `\u{X}`
  beyond the first plane, chosen by Unicode category.
- **The unsafe options are read once for each step that needs them.** The SDK build read `options.unsafe` three
  times and the warning about turned-off redactions four times, so an option object whose `unsafe` is a getter
  could make the warning and the SDK disagree. Each step reads it once.
- **A bound logger whose promise rejects no longer swallows the report.** The hook absorbed the rejection of a
  `TELEMETRY_LOGGER` method (1.0.7) but then wrote nothing, so a failed flush, a shutdown that hit its deadline or
  a failed span export vanished with it. The failed flush now goes to the Nest logger under `TRACING_FLUSH_FAILED`
  with a short code, and the other two take a process warning, as they do with no logger bound.

### Documentation

- **The README says that an unknown sampler name is not warned about.** A name that is not a sampler name
  up to case and whitespace, such as `xyz` or `always_offf`, samples every trace without a warning. It also names
  `app.useLogger()` next to `Logger.overrideLogger`, which it calls, and says where a rejected report goes.
- **The README `env` option row says where the two sampler variables come from.** `OTEL_TRACES_SAMPLER` and
  `OTEL_TRACES_SAMPLER_ARG` are always read from the process environment, whatever the `env` option holds, as the
  SDK reads them.

### Apply to a derived backend

The declarations changed only by a private method on `TelemetryShutdownHook` (`reportToNestLogger`), which no
backend can call, so nothing in your types changes. A derived backend acts on these behaviours:

1. A sampler ratio warning now shows a direction or invisible character in the value as an escape, so a log match
   on that text sees the escape.
2. If a `TELEMETRY_LOGGER` method returns a promise that rejects, you now also get the Nest logger entry
   `TRACING_FLUSH_FAILED` or a process warning, where 1.0.7 wrote nothing.

## [1.0.7] - 2026-11-20

### Fixed

- **An asynchronous `TELEMETRY_LOGGER` can no longer end the process.** The hook reports a failed flush, a
  shutdown that hit its deadline and a failed span export through the application's logger and did not look
  at what the logger returned, so a logger whose promise rejected (a network sink that is down) produced an
  unhandled rejection, which ends a Node process by default. The returned promise is now absorbed, since the
  report is best effort and nothing waits for it.

### Documentation

- **The README says what a logger that throws or rejects does.** A synchronous throw, from a
  `TELEMETRY_LOGGER` or from the logger installed with `Logger.overrideLogger`, is absorbed and the shutdown
  still resolves, now pinned through a real Nest logger. A rejecting asynchronous `error` method installed
  with `overrideLogger` is not caught by Nest or by this library and is an unhandled rejection.
- **The README no longer says the library never touches the sampler variables.** It reads `OTEL_TRACES_SAMPLER`
  and `OTEL_TRACES_SAMPLER_ARG` to warn when the SDK will ignore a ratio argument or sample every trace, and the
  variable table lists them. Two other sentences are clearer: where the Nest module reports a refused flush, and
  why the Nest logger entry leaves out the error message and stack.

**Apply note.** No action is needed. If your `TELEMETRY_LOGGER` methods return promises, a rejection is now
dropped silently instead of surfacing as an unhandled rejection.

## [1.0.6] - 2026-11-18

### Added

- **A metrics contributor for `@bymax-one/nest-core`, on the new `./observability` subpath.**
  `TelemetryMetrics` registers the counter `bymax_telemetry_span_export_failures_total`, the span export
  batches the collector did not accept, with no label and with a value of 0 before the first failure. The
  exporter wrapper now counts every failed export, not only the one a minute that warns, and keeps the count
  on `globalThis` so the preload's copy and the application's copy agree. `@bymax-one/nest-core` and
  `prom-client` are optional peers, no other entry loads them, and with the core metrics feature off nothing
  is created.
- **The README catalogs the domain span names of the Bymax libraries**, with a link to each library, the
  attribute and error rules of the observability standard, and the one propagator requirement of the queue.
  A test now fails when the README leaves out an export of any subpath or an `OTEL_*` variable the
  environment reader names.
- **A start warning for a sampler name that differs from a known one only by case or whitespace.** The SDK
  compares `OTEL_TRACES_SAMPLER` exactly against `always_on`, `always_off`, `traceidratio`,
  `parentbased_always_on`, `parentbased_always_off` and `parentbased_traceidratio`, replaces any other
  value with its default and samples every trace, noting it only on a diagnostic channel. So
  `TraceIdRatio`, ` traceidratio` or `ALWAYS_OFF` kept every trace in silence. The start now warns once
  with `BYMAX_TELEMETRY_SAMPLER_NAME_UNKNOWN`, naming the name that was meant and not repeating the value.
  Measured with the real SDK: `TraceIdRatio`, ` traceidratio` and `ALWAYS_OFF` with a ratio of `0` sampled
  all 200 root spans, and the exact names sampled none.

### Changed

- **An empty or whitespace-only `OTEL_TRACES_SAMPLER_ARG` is called blank, not unset.** The ratio warning said the
  variable was "not set" for an empty or whitespace-only value, which sends the reader looking for a
  variable that exists. An unset variable still reads "not set".
- **The winston warning says when to ignore it.** It now says to ignore it when the application never
  creates a winston logger or when `OTEL_LOGS_EXPORTER` is `none`, where nothing is forwarded either way;
  the README says the same and notes that the warning also fires with `instrumentations.sendLogs: true`
  and with the `console` exporter. The sampler matching rule is in the README.

### Fixed

- **The failed-flush entry on the Nest logger no longer writes the error's message or stack.** Without a
  bound `TELEMETRY_LOGGER`, `TelemetryShutdownHook` wrote `TRACING_FLUSH_FAILED: <message>` with the stack to
  the Nest logger. The error of an exporter can carry the endpoint it called, credentials included, in both,
  so the entry now holds library text and a short error code (`UNKNOWN` unless it is an upper-case token). A bound
  `TELEMETRY_LOGGER` still receives the `Error` object itself.
- **The two preload warnings no longer write the error's text.** `BYMAX_TELEMETRY_START_FAILED` and
  `BYMAX_TELEMETRY_ESM_HOOK_UNAVAILABLE` interpolated the error, and an SDK or loader error can quote its
  configuration, an endpoint or a header among it. They now name its code and, when its message names one,
  the OpenTelemetry package, so a missing peer is still named. One reader serves them, the flush entry and
  the export warning; it reads a code only when it is a string or a number, so the `code` field of
  `BYMAX_TELEMETRY_EXPORT_FAILED` is `UNKNOWN` for any other type of code, which was passed through as text
  before.
- **An option key set to `undefined` or `null` is the same as no key, for every option that has a
  default.** A `null` in an instrumentation override, in `ignoreIncomingRequest` or in a repeated call's
  options was read as a given value: an override key set to `undefined` replaced a library default, and a
  repeated start whose options were all `null` was reported as ignoring them. `env: null` threw a `TypeError` at start instead of reading the process environment. The keys are now dropped
  before they are merged with the defaults, and each known option is read by property access, so options
  given as a class instance with getters read as a plain object does. A table covers each defaulted option
  with both values and with a class instance.

### Apply to a derived backend

The declarations gained the `./observability` subpath; nothing else about the public types changed, and
a backend that does not use it changes nothing. A derived backend acts on these behaviours:

1. To publish the failed-export counter, install `@bymax-one/nest-core` (1.1.0 or a later 1.x release) and `prom-client`
   (15), which are optional peers, with `@nestjs/common` and `reflect-metadata` that a Nest application
   already has; add `TelemetryMetrics` from `@bymax-one/nest-telemetry/observability` to the providers of
   any module, and alert on `increase(bymax_telemetry_span_export_failures_total[5m]) > 0`. The exporter
   counts every failed export from this release on, whether or not the metric is published.
2. A start can now warn with `BYMAX_TELEMETRY_SAMPLER_NAME_UNKNOWN` for a sampler name that differs from a
   known one only by case or whitespace; an environment that sets such a value was already sampling every
   trace. The existing `BYMAX_TELEMETRY_SAMPLER_ARG_INVALID` warning calls an empty or whitespace-only ratio
   argument blank instead of not set, and the winston warning text says when to ignore it. An alert or a log filter
   that matches either text needs the new words. The `TRACING_FLUSH_FAILED` entry on the Nest logger no
   longer carries the error's message or stack: bind `TELEMETRY_LOGGER` to receive the `Error` itself. The two preload warnings now read `(code <CODE>[, package <name>])` where they quoted the error's text,
   so a log filter that matched that text needs the code. The `code` of `BYMAX_TELEMETRY_EXPORT_FAILED` is `UNKNOWN` for a code that is neither a string nor a number.
3. An option key set to `undefined` or `null` is the same as no key. A backend that set a key to `undefined` in an
   instrumentation override now gets the library default, and `env: null` no longer throws a
   `TypeError` at start: the process environment is read.

## [1.0.5] - 2026-11-17

### Added

- **A start warning for a ratio sampler that has no usable ratio.** With `OTEL_TRACES_SAMPLER` set to
  `traceidratio` or `parentbased_traceidratio`, the SDK reads `OTEL_TRACES_SAMPLER_ARG` with `Number` and
  falls back to a ratio of 1 when it is unset, empty, not a number or outside 0 to 1, noting it only on a
  diagnostic channel. Every trace was then sampled without a word, which is the cost a ratio was set to
  avoid. The start now warns once with `BYMAX_TELEMETRY_SAMPLER_ARG_INVALID`, naming the variable and,
  when one was given, the value. Measured with the real SDK: `1.5`, `-1`, `10%`, `NaN`, `Infinity` and no
  value sampled all 200 root spans; `0` sampled none.

### Fixed

- **Winston log forwarding says when it cannot work.** The winston instrumentation forwards a record by
  adding a transport from `@opentelemetry/winston-transport`, which it loads with a `require` and which is
  not one of its dependencies. An application that had not installed the package got no winston record in
  the logs pipeline and no message, although 1.0.4 and the README said `sendLogs` covers winston. The start
  now warns once with `BYMAX_TELEMETRY_WINSTON_TRANSPORT_MISSING` when log sending is on, winston is
  installed for the application and the transport cannot be resolved from the instrumentation. The README
  says to install `@opentelemetry/winston-transport` as a direct dependency of the application, with what
  was measured under npm and pnpm. The check asks whether winston is installed, not loaded, so an installed
  winston the application never uses can warn once for nothing.

### Documentation

- The README says the node-redis measurements were taken with `redis` 5 and 6.

## [1.0.4] - 2026-11-14

### Security

- **`host.id` is no longer exported by default.** It is dropped from the resource, and `host.name` stays. `unsafe.exportHostId: true`
  keeps it and emits a `SecurityWarning`.
- **`process.command` is dropped with the command-line attributes.** It is `argv[1]`, which for
  `node -e code ARG` is the first argument. `unsafe.exportProcessCommandArgs: true` keeps it, with
  `process.command_args` and `process.command_line`.

### Fixed

- **A batch-processor timer value a timer cannot hold is ignored.** An `OTEL_BSP_SCHEDULE_DELAY` above
  2147483647 ms reached `setTimeout`, which Node clamps to 1 ms, and the SDK exported once per span: 40
  exports in 2 seconds in a measurement, against none at the default. An `OTEL_BSP_EXPORT_TIMEOUT` above it
  became a 1 ms timeout on the processor side. Both are now ignored, the default applies, and
  `BYMAX_TELEMETRY_BSP_VALUE_IGNORED` names the variable. The two sizes are not timers and are not limited.
- **`instrumentations.sendLogs: false` now keeps winston and bunyan records off the logs pipeline too.** It
  set the log-sending key of pino only, so with `OTEL_LOGS_EXPORTER=otlp` the records of the other two were
  forwarded whatever the option said. One option now sets the key of all three.

### Added

- `unsafe.exportHostId` on `UnsafeOptions`.
- `BYMAX_TELEMETRY_BSP_VALUE_IGNORED`: a timer variable was ignored for being longer than a timer holds.

### Apply to a derived backend

The declarations gained `unsafe.exportHostId`; a derived backend acts on these behaviours:

1. A dashboard, an alert or a join keyed on `host.id` stops matching. Key it on `host.name` or
   `service.instance.id`, or set `unsafe.exportHostId: true` and accept that the machine identifier goes to
   every collector and backend.
2. A query that reads `process.command` stops matching. `service.name` and `process.executable.path` identify
   the process, or set `unsafe.exportProcessCommandArgs: true`.
3. An application that set `instrumentations.sendLogs: false` and uses winston or bunyan with
   `OTEL_LOGS_EXPORTER=otlp` stops sending those records to the logs pipeline. Set `sendLogs: true`, or an
   override for the one library, to keep them.
4. An `OTEL_BSP_SCHEDULE_DELAY` or `OTEL_BSP_EXPORT_TIMEOUT` above 2147483647 now falls back to the default
   with a warning. Set a value up to 2147483647.

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
- **A bound `TELEMETRY_LOGGER` now receives the two runtime warnings.** `BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT` is
  reported through `errorStructured` under `TELEMETRY_SHUTDOWN_TIMEOUT_KEY` (`TRACING_SHUTDOWN_TIMEOUT`), and
  `BYMAX_TELEMETRY_EXPORT_FAILED` through the optional `warnStructured` under `TELEMETRY_EXPORT_FAILED_KEY`
  (`TRACING_EXPORT_FAILED`), with the exporter kind and the error code as metadata and never a message, an
  endpoint or a payload. With no logger bound, or a logger without the method, they stay process warnings,
  unchanged. Both keys are exported from `./nest`.
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

The declarations gained `shutdownTimeoutMs`, two exported log keys and an optional `warnStructured` on the logger shape; a derived backend acts on these behaviours:

1. A caller that branches on the rejection of `shutdown()` or `shutdownTelemetry()` to detect a collector that
   is down now has to read the `BYMAX_TELEMETRY_SHUTDOWN_TIMEOUT` and `BYMAX_TELEMETRY_EXPORT_FAILED`
   warnings instead, or set `shutdownTimeoutMs` above the time the exporter needs to give up. Measured against a
   closed port, a deadline of 5000 ms resolved at 5002 ms with the warning, and a deadline of 20000 ms rejected
   with the connection error after 7.8 s. A collector that accepts a connection and never answers took 10
   seconds, the exporter's own timeout.
2. Set `shutdownTimeoutMs` to fit the termination grace period of the platform: a shutdown that waits longer
   than the grace period is killed before it finishes.
3. A host on `TelemetryModule` that binds `TELEMETRY_LOGGER` now gets a structured entry for a down collector.
   Alert on `TRACING_SHUTDOWN_TIMEOUT` and `TRACING_EXPORT_FAILED`; the first replaces the rejection a down
   collector used to cause at shutdown. A logger that should receive the export failure needs a
   `warnStructured(logKey, message, userId, metadata)` method.
4. A route that `ignorePaths` was ignoring with a path over 2,048 characters now produces a span. Anchor the
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

[1.0.14]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.14
[1.0.13]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.13
[1.0.12]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.12
[1.0.11]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.11
[1.0.10]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.10
[1.0.9]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.9
[1.0.8]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.8
[1.0.7]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.7
[1.0.6]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.6
[1.0.5]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.5
[1.0.4]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.4
[1.0.3]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.3
[1.0.2]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.2
[1.0.1]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.1
[1.0.0]: https://github.com/bymaxone/nest-telemetry/releases/tag/v1.0.0
