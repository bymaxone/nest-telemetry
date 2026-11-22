/**
 * @fileoverview Tests that a security flag found only on the root prototype of the realm is not read as
 * the host's, while a field of the options object, of a class instance or of a class prototype still is.
 * @layer sdk
 */
import { runInNewContext } from 'node:vm'

import { readEachOption, settleInstrumentations, settleUnsafe } from './assembly'
import { readRatioSampler, readSamplerNearMiss, readTelemetryEnvironment } from './environment'
import { readOwnOrClass, requireObject } from './option-kinds'
import { settleOptions } from './settle-options'
import type { TelemetryOptions } from './types'

/** Runs `run` while `Object.prototype` carries `name`, as a polluted realm does, and then removes it. */
function polluted<T>(name: string, value: unknown, run: () => T): T {
  Object.defineProperty(Object.prototype, name, { value, configurable: true, writable: true })
  try {
    return run()
  } finally {
    delete (Object.prototype as unknown as Record<string, unknown>)[name]
  }
}

const UNSAFE = [
  'disableUrlRedaction',
  'disableRedisArgumentRedaction',
  'exportProcessCommandArgs',
  'exportHostId'
] as const

describe('an unsafe flag found only on the root prototype', () => {
  it.each(UNSAFE)('is ignored for %s, for an object and for no object at all', (name) => {
    // Scenario: a polluted realm cannot switch a redaction off for a host that never asked.
    polluted(name, true, () => {
      expect(settleUnsafe({})[name]).toBe(false)
      expect(settleUnsafe(undefined)[name]).toBe(false)
      expect(settleUnsafe(Object.create(null) as object)[name]).toBe(false)
    })
  })

  it.each(UNSAFE)('is overridden by an own value for %s', (name) => {
    // Scenario: the control: the host's own flag still wins over anything the realm carries.
    polluted(name, true, () => {
      expect(settleUnsafe({ [name]: false })[name]).toBe(false)
    })
    expect(settleUnsafe({ [name]: true })[name]).toBe(true)
  })

  it('still counts a field of a class instance and a getter of its class', () => {
    // Scenario: the control: options written as a class are the host's, whatever the root prototype carries.
    class Fields {
      disableUrlRedaction = true
    }
    class Getter {
      get exportHostId(): boolean {
        return true
      }
    }
    expect(settleUnsafe(new Fields()).disableUrlRedaction).toBe(true)
    expect(settleUnsafe(new Getter()).exportHostId).toBe(true)
    expect(settleUnsafe(Object.create({ exportHostId: true }) as object).exportHostId).toBe(true)
  })
})

describe('an instrumentation option found only on the root prototype', () => {
  it.each(['fs', 'sendLogs'] as const)('is ignored for %s', (name) => {
    // Scenario: a polluted realm cannot turn on the export of log records or of file spans.
    polluted(name, true, () => {
      expect(settleInstrumentations({})[name]).toBeUndefined()
      expect(settleInstrumentations(undefined)[name]).toBeUndefined()
    })
    expect(settleInstrumentations({ [name]: true })[name]).toBe(true)
  })

  it('is ignored for the overrides, and a class instance still counts', () => {
    // Scenario: the map of overrides is read the same way as the flags beside it.
    polluted('overrides', { pino: { disableLogSending: false } }, () => {
      expect(settleInstrumentations({}).overrides).toBeUndefined()
    })
    class Holder {
      overrides = { pino: { disableLogSending: false } }
    }
    expect(settleInstrumentations(new Holder()).overrides).toEqual({
      pino: { disableLogSending: false }
    })
  })
})

describe('readOwnOrClass', () => {
  it('reads a getter once, and answers undefined for a key that nothing holds', () => {
    // Scenario: the lookup of the holder reads no value, so a getter on a class runs one time.
    let reads = 0
    class Getter {
      get flag(): boolean {
        reads += 1
        return true
      }
    }
    expect(readOwnOrClass(new Getter(), 'flag')).toBe(true)
    expect(reads).toBe(1)
    expect(readOwnOrClass({}, 'absent')).toBeUndefined()
    expect(readOwnOrClass(undefined, 'absent')).toBeUndefined()
  })

  it('refuses a key that only a prototype with no prototype holds, unless it is the root of this realm', () => {
    // Scenario: a value found only on a prototype that has none, and is not the root of this realm, is the host's
    // and not a pollution, so it must not be dropped in silence: the start is refused, naming the option. The root
    // of this realm is the one place a pollution is planted, and it is ignored. An object with no prototype that holds
    // the key itself is read.
    const data = Object.create(null) as Record<string, unknown>
    data['flag'] = true
    expect(() => readOwnOrClass(Object.create(data) as object, 'flag', 'unsafe.flag')).toThrow(
      expect.objectContaining({ code: 'BYMAX_TELEMETRY_OPTION_INVALID', option: 'unsafe.flag' })
    )
    expect(readOwnOrClass(data, 'flag')).toBe(true)
    polluted('flag', true, () => {
      expect(readOwnOrClass({}, 'flag')).toBeUndefined()
    })
    const named = Object.create(Object.create(null, { serviceName: { value: 'api' } })) as object
    expect(() => settleOptions(named as TelemetryOptions)).toThrow(
      expect.objectContaining({ option: 'serviceName' })
    )
  })

  it.each([
    ['unsafe', 'disableUrlRedaction', 'unsafe.disableUrlRedaction'],
    ['unsafe', 'disableRedisArgumentRedaction', 'unsafe.disableRedisArgumentRedaction'],
    ['unsafe', 'exportProcessCommandArgs', 'unsafe.exportProcessCommandArgs'],
    ['unsafe', 'exportHostId', 'unsafe.exportHostId'],
    ['instrumentations', 'fs', 'instrumentations.fs'],
    ['instrumentations', 'sendLogs', 'instrumentations.sendLogs'],
    ['instrumentations', 'overrides', 'instrumentations.overrides']
  ])(
    'names %s.%s, and says where to put it, when only a prototype with no prototype holds it',
    (group, name, option) => {
      // Scenario: the error names the option as the host wrote it and tells the host what to do.
      const held = Object.create(Object.create(null, { [name]: { value: true } })) as object
      const settle = group === 'unsafe' ? settleUnsafe : settleInstrumentations
      expect(() => settle(held)).toThrow(
        expect.objectContaining({
          option,
          message: expect.stringContaining('set on the options object itself or on a class')
        })
      )
    }
  )

  it('does not depend on the constructor of the root prototype, here or in another realm', () => {
    // Scenario: a root whose constructor was overwritten is still the end of the chain, and an object
    // of a vm context, whose root is not this realm's, is judged the same way.
    const original = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'constructor'
    ) as PropertyDescriptor
    Object.defineProperty(Object.prototype, 'constructor', {
      value: 'overwritten',
      configurable: true,
      writable: true
    })
    try {
      polluted('flag', true, () => {
        expect(readOwnOrClass({}, 'flag')).toBeUndefined()
        expect(settleUnsafe({}).disableUrlRedaction).toBe(false)
        expect(requireObject('x', {})).toEqual({})
      })
    } finally {
      Object.defineProperty(Object.prototype, 'constructor', original)
    }
    const foreign = runInNewContext(
      'Object.prototype.flag = true; Object.prototype.constructor = 1; ({ own: 1, nested: {} })'
    ) as { own: number }
    expect(() => readOwnOrClass(foreign, 'flag')).toThrow(
      expect.objectContaining({ option: 'flag' })
    )
    expect(readOwnOrClass(foreign, 'own')).toBe(1)
    expect(requireObject('x', foreign)).toBe(foreign)
  })
})

/** Every option a call can carry, taken from the reader, so an option added later is covered too. */
const OPTION_KEYS = Object.keys(readEachOption({}))

describe('an option of the call found only on the root prototype', () => {
  it.each(OPTION_KEYS)('is not read for %s', (name) => {
    // Scenario: a polluted realm cannot hand a host that passed nothing a group of unsafe flags, of
    // instrumentation overrides or of environment values, nor any other option of the call.
    polluted(name, { disableUrlRedaction: true, overrides: {} }, () => {
      expect(readEachOption({})[name as keyof TelemetryOptions]).toBeUndefined()
      expect(Object.keys(settleOptions({}))).toEqual([])
    })
  })

  it('is not read for a host that passed an options object with a null prototype', () => {
    // Scenario: the control for a host that wrote its options with no prototype at all.
    polluted('unsafe', { disableUrlRedaction: true }, () => {
      expect(readEachOption(Object.create(null) as TelemetryOptions)['unsafe']).toBeUndefined()
    })
  })

  it('still reads an own option, a field of a class and a getter of a class', () => {
    // Scenario: the control: the host's own options are read whatever the root prototype carries.
    class Fields {
      serviceName = 'from-field'
    }
    class Getter {
      get serviceVersion(): string {
        return '1.2.3'
      }
    }
    polluted('serviceName', 'polluted', () => {
      expect(readEachOption({ serviceName: 'own' }).serviceName).toBe('own')
      expect(readEachOption(new Fields()).serviceName).toBe('from-field')
    })
    expect(readEachOption(new Getter()).serviceVersion).toBe('1.2.3')
  })

  it('leaves the copy of the call with no prototype, so a later read cannot inherit one', () => {
    // Scenario: the settled options are read key by key by the start; an absent key must stay absent.
    const settled = settleOptions({ serviceName: 'api' })
    expect(Object.getPrototypeOf(settled)).toBeNull()
    polluted('unsafe', { disableUrlRedaction: true }, () => {
      expect((settled as Record<string, unknown>)['unsafe']).toBeUndefined()
    })
  })
})

describe('an environment variable found only on the root prototype', () => {
  it.each([
    ['OTEL_SDK_DISABLED', 'true'],
    ['OTEL_SERVICE_NAME', 'planted'],
    ['OTEL_BSP_MAX_QUEUE_SIZE', '7'],
    ['OTEL_BSP_SCHEDULE_DELAY', '7'],
    ['OTEL_BSP_EXPORT_TIMEOUT', '7'],
    ['OTEL_BSP_MAX_EXPORT_BATCH_SIZE', '7'],
    ['OTEL_NODE_RESOURCE_DETECTORS', 'none'],
    ['OTEL_METRICS_EXPORTER', 'otlp'],
    ['OTEL_LOGS_EXPORTER', 'otlp']
  ])('is not read for %s, from the host env or from the process env', (name, value) => {
    // Scenario: a polluted realm cannot switch the SDK off, rename the service or tune the exporter.
    const clean = JSON.stringify(readTelemetryEnvironment({}))
    const cleanProcess = JSON.stringify(readTelemetryEnvironment())
    polluted(name, value, () => {
      expect(JSON.stringify(readTelemetryEnvironment())).toBe(cleanProcess)
      expect(JSON.stringify(readTelemetryEnvironment({}))).toBe(clean)
      expect(JSON.stringify(readTelemetryEnvironment(Object.create(null) as never))).toBe(clean)
    })
  })

  it('is not read for a sampler variable, and an own variable is still read', () => {
    // Scenario: the same rule for the two sampler readers, and the control for a variable the env owns.
    polluted('OTEL_TRACES_SAMPLER', 'traceidratio', () => {
      expect(readSamplerNearMiss()).toBeUndefined()
      expect(readRatioSampler()).toBeUndefined()
      expect(readSamplerNearMiss({})).toBeUndefined()
      expect(readRatioSampler({})).toBeUndefined()
    })
    expect(readTelemetryEnvironment({ OTEL_SDK_DISABLED: 'true' }).sdkDisabled).toBe(true)
  })
})
