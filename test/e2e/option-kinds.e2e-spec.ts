/**
 * @fileoverview Pins that the real library refuses an option of the wrong kind before it starts
 * anything, names the option, and never repeats the value it was given.
 * @layer e2e
 */
import { ignorePaths, shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'
import type { TelemetryOptions } from '@bymax-one/nest-telemetry'

import { allowRestart } from './fixtures/restart'

const SECRET = 'hunter2-sentinel'

/** The error a start rejects with, or `undefined` when it started. */
async function refusal(options: unknown): Promise<Error | undefined> {
  try {
    await startTelemetry(options as TelemetryOptions)
    return undefined
  } catch (error) {
    return error as Error
  }
}

afterEach(async () => {
  await shutdownTelemetry()
  allowRestart()
})

describe('startTelemetry in the real library, for an option of the wrong kind', () => {
  it.each([
    ['enabled', { enabled: SECRET }, 'a boolean'],
    ['instrumentations.sendLogs', { instrumentations: { sendLogs: 'false' } }, 'a boolean'],
    ['unsafe.exportHostId', { unsafe: { exportHostId: 'true' } }, 'a boolean'],
    ['serviceName', { serviceName: 5 }, 'a string'],
    ['ignoreIncomingRequest', { ignoreIncomingRequest: SECRET }, 'a function'],
    ['unsafe', { unsafe: true }, 'an object'],
    ['env', { env: [] }, 'an object'],
    ['unsafe', { unsafe: new Map([['exportHostId', true]]) }, 'an object'],
    ['instrumentations', { instrumentations: new Date(0) }, 'an object'],
    [
      'instrumentations.overrides',
      { instrumentations: { overrides: { http: SECRET } } },
      'an object'
    ],
    ['extraRedactedQueryParams', { extraRedactedQueryParams: SECRET }, 'an array of strings'],
    ['extraRedactedQueryParams', { extraRedactedQueryParams: [SECRET, 1] }, 'an array of strings']
  ])('refuses %s, names it, and leaves the value out', async (name, options, expected) => {
    // Scenario: the option holds a value of another kind. The start rejects with a typed error that
    // names the option and what it must be, and the host's value stays out of the message.
    const error = await refusal(options)
    expect(error).toMatchObject({ code: 'BYMAX_TELEMETRY_OPTION_INVALID', option: name })
    expect(error?.message).toContain(`The ${name} option must be ${expected}`)
    expect(error?.message).not.toContain(SECRET)
  })

  it('refuses a list that is too long, and a length that is not a count', async () => {
    // Scenario: a list over the cap, and a stand-in for an array whose length is not an integer.
    const long = await refusal({ extraRedactedQueryParams: new Array<string>(1001).fill('a') })
    expect(long?.message).toContain('an array of at most 1000 strings')
    const odd = new Proxy(['a'], {
      get: (target, key, receiver): unknown =>
        key === 'length' ? 1.5 : (Reflect.get(target, key, receiver) as unknown)
    })
    expect(await refusal({ extraRedactedQueryParams: odd })).toMatchObject({
      option: 'extraRedactedQueryParams'
    })
  })

  it.each([
    ['instrumentations.overrides[].disableLogSending', { disableLogSending: 0 }, 'a boolean'],
    ['instrumentations.overrides[].enabled', { enabled: SECRET }, 'a boolean'],
    [
      'instrumentations.overrides[].redactedQueryParams',
      { redactedQueryParams: SECRET },
      'an array'
    ],
    ['instrumentations.overrides[].<a hook>', { requestHook: SECRET }, 'a function']
  ])(
    'refuses the setting %s of an override, and leaves the value out',
    async (name, entry, expected) => {
      // Scenario: a setting of an override that decides what leaves the host, or runs host code, has the
      // wrong kind; the start is refused with a fixed path that holds none of the host's own words.
      const error = await refusal({
        instrumentations: { overrides: { '@opentelemetry/instrumentation-pino': entry } }
      })
      expect(error).toMatchObject({ code: 'BYMAX_TELEMETRY_OPTION_INVALID', option: name })
      expect(error?.message).toContain(expected)
      expect(error?.message).not.toContain(SECRET)
    }
  )

  it('refuses an override of more settings than the cap', async () => {
    // Scenario: one entry with more settings than the cap.
    const entry = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`s${i}`, i]))
    const error = await refusal({
      instrumentations: { overrides: { '@opentelemetry/instrumentation-pino': entry } }
    })
    expect(error?.message).toContain('an object of at most 1000 settings')
  })

  it('refuses a __proto__ key in an override, from JSON.parse', async () => {
    // Scenario: configuration read from JSON carries `__proto__` as an own key; it is refused and never
    // becomes the prototype of a copy.
    const overrides = JSON.parse(
      '{"@opentelemetry/instrumentation-pino":{"__proto__":{"enabled":true}}}'
    )
    const error = await refusal({ instrumentations: { overrides } })
    expect(error?.message).toContain('free of a __proto__ key')
  })

  it('refuses overrides over the cap', async () => {
    // Scenario: a map with more entries than the cap.
    const overrides = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`i${i}`, {}]))
    const error = await refusal({ instrumentations: { overrides } })
    expect(error?.message).toContain('an object of at most 1000 entries')
  })

  it.each([
    [
      'nested more than 16 levels deep',
      () => {
        let inner: unknown = {}
        for (let level = 0; level < 17; level++) inner = { next: inner }
        return inner
      },
      'nested at most 16 levels deep'
    ],
    [
      'holding more than 10,000 objects and lists',
      () => Array.from({ length: 11 }, () => Array.from({ length: 999 }, () => ({}))),
      'at most 10,000 objects and lists in all'
    ],
    [
      'a list of more than 1000 entries',
      () => ({ list: new Array(1001).fill(0) }),
      'a list of at most 1000'
    ],
    [
      'an object of more than 1000 entries',
      () => Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`k${i}`, 0])),
      'an object of at most 1000 entries'
    ],
    [
      'a __proto__ key one level down',
      () => JSON.parse('{"a":{"__proto__":1}}'),
      'free of a __proto__ key'
    ]
  ])('refuses a setting of an override %s', async (_label, build, words) => {
    // Scenario: a setting the host nests in an override is copied within bounds, and a start refuses one
    // beyond them, naming the bound and never the value.
    const error = await refusal({
      instrumentations: {
        overrides: {
          '@opentelemetry/instrumentation-http': { headersToSpanAttributes: build() }
        }
      }
    })
    expect(error?.message).toContain(words)
  })

  it('refuses a hole in a list of strings', async () => {
    // Scenario: a hole is a missing entry, not whatever a prototype holds at that index, and a list of
    // strings refuses a missing entry.
    const sparse: unknown[] = []
    sparse[1] = 'session'
    const error = await refusal({ extraRedactedQueryParams: sparse })
    expect(error?.message).toContain('an array of strings')
  })

  it('still starts when a getter of the host lengthens the chain of its own options after the check', async () => {
    // Scenario: the chain was within bounds when it was checked and is longer when a later option is read;
    // the lookup stops at the bound and reads the option as absent, so nothing hangs and the start goes on.
    let longer: object = Object.prototype
    for (let level = 0; level < 150; level++) longer = Object.create(longer) as object
    const instrumentations = {
      get fs(): boolean {
        Object.setPrototypeOf(this, longer)
        return false
      }
    }
    const handle = await startTelemetry({ instrumentations })
    expect(handle.enabled).toBe(true)
    // The getter ran and the chain is the longer one, so the lookup that followed met the bound.
    expect(Object.getPrototypeOf(instrumentations)).toBe(longer)
  })

  it('refuses an option that only a prototype with no prototype holds, naming it, and does not drop it', async () => {
    // Scenario: a value the host put on a parent object with no prototype is the host's, so the start fails and
    // tells it to put the option on the options object; the root prototype of the realm, where a pollution is
    // planted, is the one place that is ignored.
    const parent = Object.create(null, { serviceName: { value: 'api' } }) as object
    const error = await refusal(Object.create(parent))
    expect(error?.message).toContain(
      'The serviceName option must be set on the options object itself'
    )
    const unsafe = Object.create(Object.create(null, { exportHostId: { value: true } })) as object
    expect((await refusal({ unsafe }))?.message).toContain('unsafe.exportHostId')
  })

  it('starts nothing for a refused call, and a later call starts', async () => {
    // Scenario: the refusal leaves no SDK behind, so a valid call right after it starts one.
    await refusal({ instrumentations: { sendLogs: 'false' } })
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://127.0.0.1:1'
    try {
      const handle = await startTelemetry({ serviceName: 'api', env: process.env })
      expect(handle.enabled).toBe(true)
    } finally {
      delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
    }
  })

  it('keeps the patterns of ignorePaths whole, and refuses ones that only look like expressions', () => {
    // Scenario: an array subclass that hides its entries still ignores its paths, and a stand-in is refused.
    class Hollow extends Array<RegExp> {
      override map(): never[] {
        return []
      }
    }
    const given = new Hollow()
    given.push(/^\/health$/)
    expect(ignorePaths(given)({ url: '/health' })).toBe(true)
    expect(() => ignorePaths([{ source: '.*', flags: '' }] as never)).toThrow(
      'must be an array of regular expressions'
    )
    expect(() => ignorePaths(null as never)).toThrow('must be an array of regular expressions')
    const boom = new Error('host trap failed')
    const throwing = new Proxy([/^\/a$/], {
      get: (target, key, receiver): unknown => {
        if (key === 'length') throw boom
        return Reflect.get(target, key, receiver) as unknown
      }
    })
    expect(() => ignorePaths(throwing)).toThrow(
      expect.objectContaining({ code: 'BYMAX_TELEMETRY_OPTION_INVALID', cause: boom })
    )
    const bad = /a/
    Object.defineProperty(bad, 'flags', { get: () => 'zz' })
    expect(() => ignorePaths([bad])).toThrow(
      expect.objectContaining({
        code: 'BYMAX_TELEMETRY_OPTION_INVALID',
        cause: expect.any(SyntaxError)
      })
    )
    const hidden = new Proxy([/^\/health$/], {
      get: (target, key, receiver): unknown =>
        key === 'length' ? 0 : (Reflect.get(target, key, receiver) as unknown)
    })
    expect(() => ignorePaths(hidden)).toThrow('must be an array of regular expressions')
    // An empty list that holds no index key is an empty list, not a hidden one.
    expect(() => ignorePaths([])).not.toThrow()
    const tagged: RegExp[] = []
    Object.assign(tagged, { note: 'metadata, not an entry' })
    expect(() => ignorePaths(tagged)).not.toThrow()
  })
})
