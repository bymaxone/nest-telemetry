/**
 * @fileoverview Reads the options of one `startTelemetry` call once, checks the kind of each, and
 * copies them into a plain object that every step of the call works from.
 * @layer sdk
 */
import { readEachOption, settleInstrumentations, settleUnsafe } from './assembly'
import {
  isGiven,
  requireBoolean,
  requireFunction,
  requireObject,
  requireString,
  settleStringList
} from './option-kinds'
import { create, entries } from './primordials'
import type { TelemetryOptions } from './types'

/**
 * Reads each option of a call once and refuses one of the wrong kind, so the warning text, the
 * decision to start and the SDK that is built all work from the same values. An option that is
 * absent, `undefined` or `null` has no key in the copy.
 *
 * @param options - The options of a call.
 * @returns A copy with no prototype: the nested options are copies too, and the list is an array of strings.
 * @throws {TelemetryOptionError} When an option is of the wrong kind or a list or map is too long.
 */
export function settleOptions(options: TelemetryOptions): TelemetryOptions {
  requireObject('options', options)
  const read = readEachOption(options)
  const settled: Record<string, unknown> = {
    enabled: requireBoolean('enabled', read.enabled),
    serviceName: requireString('serviceName', read.serviceName),
    serviceVersion: requireString('serviceVersion', read.serviceVersion),
    ignoreIncomingRequest: requireFunction('ignoreIncomingRequest', read.ignoreIncomingRequest),
    instrumentations: isGiven(read.instrumentations)
      ? settleInstrumentations(read.instrumentations)
      : undefined,
    extraRedactedQueryParams: settleStringList(
      'extraRedactedQueryParams',
      read.extraRedactedQueryParams
    ),
    unsafe: isGiven(read.unsafe) ? settleUnsafe(read.unsafe) : undefined,
    shutdownTimeoutMs: read.shutdownTimeoutMs,
    env: requireObject('env', read.env)
  }
  // No prototype: a key the call did not give stays absent when the start reads it, whatever the root
  // prototype of the realm carries.
  const given = create(null) as Record<string, unknown>
  const pairs = entries(settled)
  for (let at = 0; at < pairs.length; at += 1) {
    const pair = pairs[at] as [string, unknown]
    if (isGiven(pair[1])) given[pair[0]] = pair[1]
  }
  return given as TelemetryOptions
}
