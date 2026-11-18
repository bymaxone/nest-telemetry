/**
 * @fileoverview Warns when winston log forwarding is on but the transport it needs cannot be found.
 * @layer sdk
 *
 * `@opentelemetry/instrumentation-winston` forwards a winston record by adding a transport from
 * `@opentelemetry/winston-transport`, which it loads with a `require` when a logger is configured. The
 * package is not one of its dependencies, so an application that does not install it gets no winston
 * record in the logs pipeline, and the only trace is a diagnostic note nobody reads.
 *
 * The check runs at start, before winston is usually loaded, so it asks whether winston is installed
 * for the application, not whether it is loaded: an installed winston that the application never uses
 * can produce one warning for nothing. Every package is looked up from the place its user would look
 * from, through an injected resolver.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

import { reportWarning } from './warning-sink'

/** Resolves `id` from the file `from`, or returns `undefined` when it cannot be resolved. */
export type Resolve = (id: string, from: string) => string | undefined

/** The package the winston instrumentation needs, and the one that names it. */
const TRANSPORT = '@opentelemetry/winston-transport'
const BUNDLE = '@opentelemetry/auto-instrumentations-node'
const INSTRUMENTATION = '@opentelemetry/instrumentation-winston'

/** The text of the warning. */
const MESSAGE =
  `Log forwarding is on and winston is installed, but ${TRANSPORT} cannot be resolved from ` +
  `${INSTRUMENTATION}, so winston records will not be forwarded. Install ${TRANSPORT} as a ` +
  'direct dependency of the application, or set instrumentations.sendLogs to false. Ignore this if the ' +
  'application never creates a winston logger, or if OTEL_LOGS_EXPORTER is none: nothing is forwarded then either way.'

/**
 * Resolves a package the way Node does for a file, from that file's directory upwards.
 *
 * @param id - The package to resolve.
 * @param from - The file the lookup starts from.
 * @returns The resolved file, or `undefined` when there is none.
 */
export const resolveFrom: Resolve = (id, from) => {
  try {
    return createRequire(from).resolve(id)
  } catch {
    return undefined
  }
}

/**
 * The file the application was started from, which stands for where its own `node_modules` is searched.
 *
 * @param argv - The process arguments.
 * @param cwd - The working directory, used when there is no script.
 * @returns A path that `createRequire` can start from.
 */
export function entryFile(
  argv: readonly string[] = process.argv,
  cwd: string = process.cwd()
): string {
  return argv[1] ?? join(cwd, 'entry.js')
}

/**
 * Whether winston forwarding would silently do nothing: winston is installed for the application, the
 * winston instrumentation is found through the auto-instrumentations package the application has, and
 * the transport does not resolve from that instrumentation. Any lookup that fails before the last one
 * leaves the answer unknown, so it is `false`.
 *
 * @param entry - The file the application started from.
 * @param resolve - The resolver.
 * @returns `true` when the transport is missing.
 */
export function transportMissing(entry: string, resolve: Resolve): boolean {
  if (resolve('winston', entry) === undefined) return false
  const bundle = resolve(BUNDLE, entry)
  if (bundle === undefined) return false
  const instrumentation = resolve(INSTRUMENTATION, bundle)
  if (instrumentation === undefined) return false
  return resolve(TRANSPORT, instrumentation) === undefined
}

/**
 * Reports the missing transport once, when log sending is on.
 *
 * @param sendLogs - Whether the records of the logging libraries are forwarded.
 * @param entry - The file the application started from.
 * @param resolve - The resolver.
 */
export function warnAboutMissingWinstonTransport(
  sendLogs: boolean,
  entry: string = entryFile(),
  resolve: Resolve = resolveFrom
): void {
  if (sendLogs && transportMissing(entry, resolve)) {
    reportWarning({ code: 'BYMAX_TELEMETRY_WINSTON_TRANSPORT_MISSING', text: MESSAGE })
  }
}
