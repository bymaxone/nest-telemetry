/**
 * @fileoverview Pins which settings the real auto-instrumentations read from their configuration while they
 * are built, the one moment the library cannot cut that configuration from the root prototype: each such
 * setting must be an own key that the library sets, so a package that starts to read another one fails here.
 * @layer e2e
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { InstrumentationBase } from '@opentelemetry/instrumentation'

import { buildInstrumentationConfig } from '../../src/sdk/assembly'

/** The settings read while building, by instrumentation name; an empty set for one that read none. */
type Reads = Map<string, Set<string>>

/**
 * Builds the real instrumentations from a configuration and records every setting each reads from the copy
 * of that configuration, and does not find as an own key, before the build ends.
 *
 * @param config - The configuration handed to `getNodeAutoInstrumentations`.
 * @returns What each instrumentation read.
 */
function readWhileBuilt(config: object): Reads {
  const reads: Reads = new Map()
  const original = InstrumentationBase.prototype.setConfig
  InstrumentationBase.prototype.setConfig = function (
    this: InstrumentationBase,
    given: object
  ): void {
    const name = this.instrumentationName
    const known = reads.get(name) ?? new Set<string>()
    reads.set(name, known)
    const copy = { enabled: true, ...given }
    Object.assign(this, {
      _config: new Proxy(copy, {
        get(target, key, receiver): unknown {
          if (typeof key === 'string' && !Object.hasOwn(target, key)) known.add(key)
          return Reflect.get(target, key, receiver)
        },
        has(target, key): boolean {
          if (typeof key === 'string' && !Object.hasOwn(target, key)) known.add(`${key} (in)`)
          return Reflect.has(target, key)
        }
      })
    })
  }
  try {
    getNodeAutoInstrumentations(config as never)
  } finally {
    InstrumentationBase.prototype.setConfig = original
  }
  return reads
}

/** The names read by any instrumentation, as `package: name` lines. */
function lines(reads: Reads): string[] {
  return [...reads]
    .flatMap(([name, keys]) =>
      [...keys].map((key) => `${name.replace('@opentelemetry/instrumentation-', '')}: ${key}`)
    )
    .sort()
}

describe('the settings the real instrumentations read while they are built', () => {
  it('are all own keys of the configuration the library builds', () => {
    // Scenario: with the library's configuration no setting is read that is not an own key, so a value a
    // polluted root prototype holds is never found; a package that begins to read a new setting at
    // construction time, such as a floating dependency version, adds a line here and fails.
    const reads = readWhileBuilt(buildInstrumentationConfig({}, { sendLogs: false } as never))
    expect(reads.size).toBeGreaterThanOrEqual(35)
    expect(lines(reads)).toEqual([])
  })

  it('are found by the same probe in a configuration without them, so the probe can see a read', () => {
    // Scenario: the control; given nothing, the instrumentations that read a setting while they are built
    // are the ones the library gives an own key for.
    const reads = readWhileBuilt({})
    const found = lines(reads).map((line) => line.split(': ')[0] as string)
    expect(found).toEqual(expect.arrayContaining(['http', 'grpc']))
  })
})
