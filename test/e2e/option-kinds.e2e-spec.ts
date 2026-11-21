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
    const hidden = new Proxy([/^\/health$/], {
      get: (target, key, receiver): unknown =>
        key === 'length' ? 0 : (Reflect.get(target, key, receiver) as unknown)
    })
    expect(() => ignorePaths(hidden)).toThrow('must be an array of regular expressions')
  })
})
