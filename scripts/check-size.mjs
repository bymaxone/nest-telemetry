#!/usr/bin/env node
// Zero-dependency bundle-size gate. Measures every published subpath's ESM
// bundle (raw + brotli-compressed) and fails when any subpath exceeds the
// hard-coded budget below.
//
// Why zero deps: this is a telemetry library that ships `"dependencies": {}` on
// purpose. The CI/release runner must stay free of third-party tooling so a
// compromised devDep cannot tamper with the bundle before `pnpm publish`.
// `node:zlib`'s brotli matches what npm/CDN compression produces on the wire.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Budgets are in bytes (KiB units, `n * 1024`, matching the table's ÷1024
// display) measured against the brotli'd .mjs bundle — what a consumer's
// bundler/CDN ships. Brotli, not gzip, to match real wire compression.
//
// Bymax bundle-size convention (canonical: Obsidian → 03 - Resources/NestJS/
// Bymax-Conventions.md → "Bundle-size budgets"):
//   1. The .mjs ships UNMINIFIED with JSDoc (tsup `minify: false`) on purpose —
//      readable stack traces / source inside a consumer's node_modules outweigh
//      a few KB on a backend lib that never reaches a browser. We do NOT minify
//      a lib just to satisfy a size budget.
//   2. The budget is CALIBRATED to the real built artifact + MODEST headroom:
//      enough to absorb normal inter-release growth, tight enough to catch
//      accidental bloat (e.g. a peer dep leaking into the bundle). It is a
//      bloat tripwire, NOT a hard design ceiling — when real growth is
//      legitimate, raise it (and say why here); when the artifact shrinks,
//      tighten it. Avoid >2x headroom: it silently lets bloat through.
//
// Calibration history (newest first):
//   - 2026-11-26 (sdk, register and the sdk CommonJS bundle, PM grant of the same day, at the measured size plus 30 B):
//     sdk 12,836 B measured, 12,866 B budget, written as 12.565 KiB; register 12,974 B, 13,004 B, as 12.7 KiB; sdk
//     CommonJS 12,881 B, 12,911 B, as 12.609 KiB. The growth is the guard that keeps a promise returned by the ignore
//     hook from dropping a request, with its warning.
//   - 2026-11-26 (nest only, PM grant of the same day, at the measured size plus 30 B): nest 2,862 B measured, 2,892 B
//     budget, written as 2.825 KiB. The growth is the object entry, with its `event` and `code` fields, that the Nest
//     logger gets for a failed flush.
//   - 2026-11-24 (sdk ESM only, PM grant 2026-11-24, owner standing rule, at the measured size plus 30 B, rounded down in
//     the KiB column): sdk 12,611 B measured, 12.34 KiB budget (12,636 B, 25 B of headroom). The growth over the 12,605 B
//     of the 12.31 KiB budget is the `!==` that replaced `<` in seven loops; the register and the CommonJS budgets
//     still hold and are unchanged.
//   - 2026-11-24 (register only, PM grant 2026-11-24, owner standing rule, at the measured
//     size plus 30 B, rounded down in the KiB column): register 12,743 B measured, 12.47 KiB budget (12,769 B, 26 B of
//     headroom). The growth over the 12,706 B of the entry below, 37 B, is the start of the preload answering through a promise of its own.
//   - 2026-11-24 (every bundle but the register CommonJS stub, at the measured size plus 30 B, rounded down in the KiB
//     column; the PM's rule of the same day, applied for the wait on a promise of a host that goes through a native
//     await when its constructor is the intrinsic, and for reading a descriptor as own data): sdk 12,585 B measured,
//     12.31 KiB budget (12,605 B, 20 B of headroom); register 12,706 B, 12.43 KiB (12,728 B, 22 B); nest 2,833 B,
//     2.79 KiB (2,856 B, 23 B); observability 884 B, 0.89 KiB (911 B, 27 B); sdk CommonJS 12,624 B, 12.35 KiB
//     (12,646 B, 22 B); nest CommonJS 2,860 B, 2.82 KiB (2,887 B, 27 B); observability CommonJS 911 B, 0.91 KiB
//     (931 B, 20 B). PM grant 2026-11-24.
//   - 2026-11-24 (observability and its CommonJS bundle, at the measured size plus 30 B, rounded down in the KiB
//     column; the PM's rule of the same day, applied to the two bundles the fallback for a constructor slot that is gone
//     also reaches, since they carry the primordials): observability 829 B measured, 0.83 KiB budget (849 B, 20 B of
//     headroom); observability CommonJS 866 B, 0.87 KiB (890 B, 24 B). Not named in the PM's grant of the other three.
//   - 2026-11-24 (sdk, register and the sdk CommonJS bundle, at the measured size plus 30 B, rounded down in the KiB
//     column; the PM's rule of the same day, applied again for the host-promise wait and the missing constructor slot):
//     sdk 12,510 B measured, 12.24 KiB budget (12,533 B, 23 B of headroom); register 12,627 B, 12.36 KiB (12,657 B,
//     30 B); sdk CommonJS 12,524 B, 12.25 KiB (12,544 B, 20 B). The growth is the captured `then`, the wait through it
//     for a promise of a host or one that cannot be tagged, and the fallback for a constructor slot that is gone.
//   - 2026-11-24 (every bundle but the register CommonJS stub, at the measured size plus 30 B, rounded down in the KiB
//     column; the PM's rule of the same day, applied again for the audit fixes): sdk 12,473 B measured, 12.20 KiB budget
//     (12,493 B, 20 B of headroom); register 12,587 B, 12.32 KiB (12,616 B, 29 B); nest 2,681 B, 2.64 KiB (2,703 B,
//     22 B); observability 790 B, 0.80 KiB (819 B, 29 B); sdk CommonJS 12,506 B, 12.24 KiB (12,534 B, 28 B); nest
//     CommonJS 2,698 B, 2.66 KiB (2,723 B, 25 B); observability CommonJS 804 B, 0.81 KiB (829 B, 25 B). The growth, about
//     0.1 KiB in each, is the check that the engine's Promise reads as a fresh realm's, the engine prototype taken from
//     an async function's promise, the warning of a boot that found the process polluted and the second pin of the
//     pending start.
//   - 2026-11-24 (sdk, register, the sdk CommonJS bundle and both nest bundles, PM-granted at the measured size plus
//     30 B, rounded down in the KiB column): sdk 12,368 B measured, 12.10 KiB budget (12,390 B, 22 B of headroom);
//     register 12,472 B, 12.20 KiB budget (12,493 B, 21 B); sdk CommonJS 12,394 B, 12.13 KiB budget (12,421 B, 27 B);
//     nest 2,629 B, 2.59 KiB budget (2,652 B, 23 B); nest CommonJS 2,648 B, 2.61 KiB budget (2,673 B, 25 B). The
//     growth, about 0.14 KiB in each, is the settle helper, the error of a promise that cannot be consumed, the frozen
//     handles and the stop of an SDK that started while the process turned polluted.
//   - 2026-11-24 (sdk, register, the sdk CommonJS bundle and both nest bundles, PM-granted at the measured size plus
//     30 B, rounded down in the KiB column): sdk 12,203 B measured, 11.94 KiB budget (12,226 B, 23 B of headroom);
//     register 12,319 B, 12.05 KiB budget (12,339 B, 20 B); sdk CommonJS 12,237 B, 11.97 KiB budget (12,257 B, 20 B);
//     nest 2,442 B, 2.41 KiB budget (2,467 B, 25 B); nest CommonJS 2,459 B, 2.43 KiB budget (2,488 B, 29 B). The
//     growth is every promise a decision path returns carrying its own constructor, the flush and the module-level
//     shutdown built on native promises instead of `finally` and `allSettled`, and the guarded send in its own function.
//   - 2026-11-24 (sdk, register and the sdk CommonJS bundle, PM-granted at the measured size plus 30 B, rounded down
//     in the KiB column): sdk 12,076 B measured, 11.82 KiB budget (12,103 B, 27 B of headroom); register 12,235 B,
//     11.97 KiB budget (12,257 B, 22 B); sdk CommonJS 12,118 B, 11.86 KiB budget (12,144 B, 26 B). The growth, about
//     0.29 KiB in each, is the promise helper that attaches handlers without reading a constructor, the start
//     answering through a promise of its own, and the check before each resolve.
//   - 2026-11-24 (sdk, register and the sdk CommonJS bundle, PM-granted at the measured size plus 30 B, rounded down
//     in the KiB column): sdk 11,755 B measured, 11.50 KiB budget (11,776 B, 21 B of headroom); register 11,910 B,
//     11.66 KiB budget (11,940 B, 30 B); sdk CommonJS 11,789 B, 11.54 KiB budget (11,817 B, 28 B). The growth, about
//     0.32 KiB in each, is the start and the guarded export settling on native promises instead of awaiting.
//   - 2026-11-23 (sdk, register and the sdk CommonJS bundle, PM-granted at about the measured size plus 64 B):
//     sdk 11,357 B measured, 11.16 KiB budget (11,428 B, 71 B of headroom); register 11,519 B, 11.32 KiB budget
//     (11,592 B, 73 B: 11.31 KiB would leave 62 B, so it is rounded up); sdk CommonJS 11,400 B, 11.19 KiB budget
//     (11,458 B, 58 B). The growth over the entry below, about 110 B in each, is the rows for the iterators of an array
//     and of a set, `Set.prototype.add` and the two prototypes that the load captures, the check of an accessor on a
//     prototype of an override, and the new texts of the warnings.
//   - 2026-11-23 (sdk, register and the sdk CommonJS bundle, PM-granted; the table of guarded built-ins): sdk 11,242 B
//     measured, 11.01 KiB budget (11,274 B, 32 B of headroom); register 11,397 B, 11.16 KiB budget (11,428 B, 31 B);
//     sdk CommonJS 11,288 B, 11.06 KiB budget (11,325 B, 37 B). The growth, about 0.55 KiB in each, is the table of the
//     built-ins that the guard, the export wrap and the option settling call, the descriptors read from this realm
//     and from a fresh one, and the comparison that counts a replaced, deleted or foreign member. Rows that no
//     guarded call needs were left out of the table first.
//   - 2026-11-23 (sdk and register, and a row for the CommonJS bundle of every subpath): sdk 10,680 B measured,
//     10.46 KiB budget (10,711 B, 31 B of headroom); register 10,833 B, 10.61 KiB budget (10,865 B, 32 B). The growth,
//     233 B in each, is the code the dropped batch carries and the warning text that names the pollution. The
//     CommonJS rows, each measured plus 30 B rounded up to the KiB column: sdk 10,712 B, 10.50 KiB; register 171 B (a
//     stub that throws on require), 0.20 KiB; nest 2,233 B, 2.22 KiB; observability 733 B, 0.75 KiB.
//   - 2026-11-23 (sdk and register, PM-granted): sdk 10,447 B measured, 10.24 KiB budget (10,486 B, 39 B of
//     headroom); register 10,614 B, 10.40 KiB budget (10,650 B, 36 B). The growth, 21 B in the sdk and 42 B in
//     register, is the clock, the number conversion and the pattern match of the failure description, which are
//     now read once at load as well.
//   - 2026-11-23 (all four, PM-granted): sdk 10,426 B measured, 10.22 KiB budget (10,465 B, 39 B of
//     headroom); register 10,572 B, 10.36 KiB budget (10,608 B, 36 B); nest 2,217 B, 2.20 KiB budget (2,252 B,
//     35 B); observability 723 B, 0.74 KiB budget (757 B, 34 B). The growth, 0.14 KiB in the sdk and about
//     0.1 KiB in the others, is the table of built-ins read once at load that the export-failure callback, the
//     code reader, the warning sink and the settling of the options now call instead of looking them up.
//   - 2026-11-23 (sdk and register, PM-granted): sdk 10,250 B measured, 10.04 KiB budget (10,281 B, 31 B of
//     headroom, rounded up to the KiB column); register 10,415 B, 10.21 KiB budget (10,455 B, 40 B). The growth,
//     about 0.05 KiB in sdk and 0.06 KiB in register, is the handler that takes the rejection of a promise the
//     guard drops, with the two built-ins it needs read when the module loads.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 10,200 B measured, 10.00 KiB budget (10,240 B, 40 B of
//     headroom, rounded up to the KiB column); register 10,353 B, 10.14 KiB budget (10,383 B, 30 B). The growth,
//     about 0.07 KiB in each, is the second check after a provider of the transport has answered, which awaits an
//     answer that is a promise and returns any other answer as it is.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 10,125 B measured, 9.92 KiB budget (10,158 B, 33 B of
//     headroom, rounded up to the KiB column); register 10,287 B, 10.08 KiB budget (10,322 B, 35 B). The growth,
//     about 0.33 KiB in each, is the check before every request attempt of an exporter's transport: the walk to the
//     transport, the wrapped send and the wrapped header, metadata and credentials providers.
//   - 2026-11-22 (sdk, register and nest, PM-granted): sdk 9,783 B measured, 9.59 KiB budget (9,820 B, 37 B of
//     headroom, rounded up to the KiB column); register 9,938 B, 9.74 KiB budget (9,974 B, 36 B); nest 2,107 B,
//     2.09 KiB budget (2,140 B, 33 B). The growth, about 0.17 KiB in sdk, 0.18 KiB in register and 0.05 KiB in nest, is
//     the built-ins that the pollution guard and the export wrap read once when the module loads, the loops that
//     replace their iterators, and the helper that gives every process warning an own detail.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 9,608 B measured, 9.42 KiB budget (9,646 B, 38 B of
//     headroom); register 9,758 B, 9.56 KiB budget (9,789 B, 31 B). The growth, about 0.05 KiB in sdk and none in
//     register, is the fresh realm built when the module loads, with its retry, and the count of one for a realm
//     that cannot be compared.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 9,561 B measured, 9.37 KiB budget (9,594 B, 33 B of
//     headroom); register 9,721 B, 9.53 KiB budget (9,758 B, 37 B). The growth, about 0.03 KiB in sdk and 0.06 KiB in
//     register, is the comparison of the prototype with a fresh realm's made table-driven, and the marker of the wrap
//     of the exporter base checked by its value.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 9,527 B measured, 9.34 KiB budget (9,564 B, 37 B of
//     headroom); register 9,660 B, 9.47 KiB budget (9,697 B, 37 B). The growth, about 0.02 KiB in each, is the second
//     check of the realm's Object.prototype right before the SDK is built and the count of symbol keys.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 9,480 B measured, 9.29 KiB budget (9,512 B, 32 B of
//     headroom); register 9,622 B, 9.43 KiB budget (9,656 B, 34 B). The growth, about 0.8 KiB in each, is the check of
//     the realm's Object.prototype against a fresh realm's, the wrap that drops an export while it is polluted, the
//     refusal for an option held only by a prototype with no prototype, and the configuration of the SDK with no
//     prototype.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 8,643 B measured, 8.47 KiB budget (8,673 B, 30 B of
//     headroom); register 8,783 B, 8.61 KiB budget (8,816 B, 33 B). The growth, about 0.15 KiB in each, is the table
//     of what an instrumentation reads while it is built, and the copy of a nested object of any realm and of a
//     list by own index.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 8,485 B measured, 8.32 KiB budget (8,519 B, 34 B of
//     headroom); register 8,647 B, 8.48 KiB budget (8,683 B, 36 B). The growth, about 0.2 KiB in each, is the copy,
//     with no prototype and within bounds, of a plain object or list that the host nests in an override setting.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 8,278 B measured, 8.12 KiB budget (8,314 B, 36 B of
//     headroom); register 8,426 B, 8.26 KiB budget (8,458 B, 32 B). The growth, about 0.03 KiB in each, is the
//     configuration of the instrumentations answering an empty entry with no prototype for an instrumentation
//     name that the host did not configure.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 8,242 B measured, 8.08 KiB budget (8,273 B, 31 B of
//     headroom); register 8,385 B, 8.22 KiB budget (8,417 B, 32 B). The growth, about 0.22 KiB in each, is the
//     placeholders on the process environment while the SDK is built, the configuration of the instrumentations
//     with no prototype and cut from the root prototype, and the reads of a Proxy and of the end of a chain.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 8,002 B measured, 7.83 KiB budget (8,018 B,
//     16 B of headroom); register 8,148 B, 7.98 KiB budget (8,172 B, 24 B). The growth, about 0.03 KiB in each, is
//     the read of every option of the call, and of every variable of an environment, with the rule that a key
//     only the root prototype of the realm holds is not the host's, and the copy of the call with no prototype.
//   - 2026-11-22 (sdk and register, PM-granted): sdk 7,939 B measured, 7.77 KiB budget (7,956 B, 17 B of
//     headroom); register 8,100 B measured, 7.93 KiB budget (8,120 B, 20 B). The budget pays for the copy by
//     index and the guard of the host's lists, the kind checks of the object options by the brands Node
//     reports and a bounded chain of prototypes, and the test that keeps a flag held only by the root
//     prototype of the realm from being read as the host's.
//   - 2026-11-21 (sdk and register, PM-granted): sdk 7,241 B measured, 7.10 KiB budget (7,270 B,
//     29 B of headroom); register 7,534 B measured, 7.39 KiB budget (7,567 B, 33 B). The growth, about 0.05 KiB
//     in each, is the refusal of a `__proto__` key in an override.
//   - 2026-11-21 (sdk and register, PM-granted): sdk 7,187 B measured, 7.05 KiB budget (7,219 B,
//     32 B of headroom); register 7,488 B measured, 7.35 KiB budget (7,526 B, 38 B). The growth, about 0.16 KiB
//     in each, is the copy of each `overrides` entry and the kind check of its switches, list and hooks.
//   - 2026-11-21 (sdk and register, PM-granted): sdk 7,028 B measured, 6.90 KiB budget (7,066 B, 38 B of
//     headroom); register 7,308 B measured, 7.17 KiB budget (7,342 B, 34 B). The growth, about 0.7 KiB in each,
//     is the check of the kind of every option, with its error and the caps on lists and maps, and the single
//     read of each option of a call.
//   - observability: 673 B measured, 0.69 KiB budget (706 B, 33 B of headroom): the metrics contributor and
//     its one counter; `prom-client` and `@bymax-one/nest-core` stay external.
//   - sdk: 6,265 B measured, 6.15 KiB budget (6,297 B, 32 B of headroom), the whole subpath: redaction, the
//     environment reader, the SDK assembly, the resource-detector selection that keeps the process
//     command line out of the exported resource, the start cache and the handle lifecycle with its
//     shutdown deadline (about 0.1 KiB: the timer, its warning and the clamp of the configured
//     value), the export-failure warning (about 0.33 KiB: the exporter wrapper, the code reader and
//     the warning text), the warning sink (about 0.1 KiB), the resource attributes it removes and the timer values it refuses (about 0.27 KiB: the host-id wrapper, the timer ceiling and three warning texts), the refusal of a start after a shutdown and the warnings for a later call that
//     changes nothing, with their full explanatory text, and the winston transport check (about
//     0.38 KiB: the resolver, the three lookups and the warning text) and the sampler ratio check
//     (about 0.3 KiB: the ratio reader, the check and the warning text), the sampler name check (about
//     0.15 KiB: the six names, the near-miss reader and the warning text) and the dropping of absent option keys
//     before the merge with the defaults, each known option read by property access, and the count of
//     failed exports that the metrics contributor reads (about 0.06 KiB), and the failure description
//     that names a code and an OpenTelemetry package instead of echoing an error (about 0.04 KiB), and the escape of
//     direction, separator and invisible characters in a sampler value the warning repeats (about 0.12 KiB: the
//     category class, the escape and the single read of the unsafe options), and the single read of
//     the instrumentation options handed down to the steps (about 0.09 KiB), with a plain-object copy of the unsafe and
//     instrumentation options that reads each field once (about 0.08 KiB).
//   - register: 6,565 B measured, 6.44 KiB budget (6,594 B, 29 B of headroom). The preload bundles its own copy
//     of the start logic, shutdown deadline, export-failure warning, warning sink, resource and timer handling and the winston transport, sampler ratio and sampler name checks included: the copies share their state through
//     `globalThis`, not through a module.
//   - nest: 2,058 B measured, 2.04 KiB budget (2,089 B, 31 B of headroom), the global module and the shutdown hook
//     with every step of failure reporting guarded, the route that hands the two runtime warnings to
//     a bound structured logger, and the fallback entry that holds library text and a short error code
//     instead of the error's message and stack (about 0.1 KiB: the code reader and the longer text), and
//     the absorbed promise of an asynchronous logger (about 0.04 KiB), with the fallback report when it rejects
//     (about 0.17 KiB: the Nest logger entry as its own method, the process warning and the absorbing catch).
//   - the exception text redactor, with the `redactExceptionText` option and its environment variable
//     for the preload, is about 1.2 KiB in each bundle that holds the start logic: input quoted by a
//     `JSON.parse` message must not reach an exported span. Measured sdk 14,089 B, register 14,251 B, sdk
//     CommonJS 14,130 B; budgets measured + 30 B: 14,119 B, 14,281 B and 14,160 B (the KiB column is rounded
//     up to four places).
//   A budget is re-derived from the built artifact with modest headroom, never nudged, and never
//   met by shortening the text of a warning.
const BUDGETS = [
  { name: 'sdk (programmatic start)', path: 'dist/sdk/index.mjs', brotli: 13.7881 * 1024 },
  { name: 'register (node --import)', path: 'dist/register/index.mjs', brotli: 13.9463 * 1024 },
  { name: 'nest (module + shutdown)', path: 'dist/nest/index.mjs', brotli: 2.825 * 1024 },
  { name: 'observability (metrics)', path: 'dist/observability/index.mjs', brotli: 0.89 * 1024 },
  { name: 'sdk (CommonJS)', path: 'dist/sdk/index.cjs', brotli: 13.8282 * 1024 },
  { name: 'register (CommonJS)', path: 'dist/register/index.cjs', brotli: 0.2 * 1024 },
  { name: 'nest (CommonJS)', path: 'dist/nest/index.cjs', brotli: 2.82 * 1024 },
  { name: 'observability (CommonJS)', path: 'dist/observability/index.cjs', brotli: 0.91 * 1024 }
]

const fmt = (n) => `${(n / 1024).toFixed(2)} kB`

const BROTLI_OPTS = {
  params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY }
}

// `PACKAGE_TARBALL` names the tarball a release gate has already packed: the bundles are read from
// the file that is published, not from `dist/`.
const TARBALL = process.env['PACKAGE_TARBALL']

/** The member names of the tarball, listed once. */
let tarballMembers

/**
 * Reads one built artifact, from the tarball when there is one, else from `dist/`.
 *
 * The listing of the tarball fails with `tar`'s own message on a file that is not a readable
 * archive, so only a member that is absent from a readable archive counts as a missing artifact.
 *
 * @param {string} path - The artifact path relative to the package root.
 * @returns {Buffer} The file content.
 */
function readArtifact(path) {
  if (TARBALL === undefined || TARBALL === '') return readFileSync(resolve(ROOT, path))
  tarballMembers ??= new Set(
    execFileSync('tar', ['-tzf', TARBALL], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split(
      '\n'
    )
  )
  if (!tarballMembers.has(`package/${path}`)) {
    throw Object.assign(new Error(`${path} is not in the tarball`), { code: 'ENOENT' })
  }
  return execFileSync('tar', ['-xzOf', TARBALL, `package/${path}`], {
    maxBuffer: 16 * 1024 * 1024
  })
}

let failed = 0
const rows = []

for (const { name, path, brotli: limit } of BUDGETS) {
  // Read straight away rather than testing for the file first. A `statSync`
  // followed by `readFileSync` states a fact about the past: the file can be
  // gone, replaced, or truncated between the two calls. `readFileSync` already
  // fails when the artifact is missing, so one call reports the same thing
  // without the window.
  let raw
  try {
    raw = readArtifact(path)
  } catch (error) {
    // Only a missing file earns the friendly message. A permission error or a
    // directory where a file belongs is a different problem, and reporting it as
    // "run pnpm build" sends the reader to the wrong place — rethrow so the real
    // code and stack reach the log.
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    console.error(`Missing build artifact: ${path} — run \`pnpm build\` first.`)
    process.exit(2)
  }
  const compressed = brotliCompressSync(raw, BROTLI_OPTS).length
  const ok = compressed <= limit
  if (!ok) failed += 1
  rows.push({
    name,
    raw: raw.length,
    brotli: compressed,
    limit,
    delta: compressed - limit,
    ok
  })
}

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

console.log('')
console.log(
  `  ${pad('Subpath', 38)}${padL('Raw', 12)}${padL('Brotli', 12)}${padL('Budget', 12)}  Status`
)
console.log(`  ${'-'.repeat(38)}${'-'.repeat(12)}${'-'.repeat(12)}${'-'.repeat(12)}  ------`)
for (const r of rows) {
  const status = r.ok ? 'PASS' : `FAIL +${fmt(r.delta)}`
  console.log(
    `  ${pad(r.name, 38)}${padL(fmt(r.raw), 12)}${padL(fmt(r.brotli), 12)}${padL(fmt(r.limit), 12)}  ${status}`
  )
}
console.log('')

if (failed > 0) {
  console.error(`${failed} subpath(s) exceeded the brotli budget.`)
  process.exit(1)
}
