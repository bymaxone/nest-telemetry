/**
 * @fileoverview Pins that the real library refuses an option of the wrong kind before it starts
 * anything, names the option, and never repeats the value it was given.
 * @layer e2e
 */
import { shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'
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
})
