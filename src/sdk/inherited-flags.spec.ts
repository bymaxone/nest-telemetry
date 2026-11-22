/**
 * @fileoverview Tests that a security flag found only on the root prototype of the realm is not read as
 * the host's, while a field of the options object, of a class instance or of a class prototype still is.
 * @layer sdk
 */
import { readRatioSampler, readSamplerNearMiss, readTelemetryEnvironment } from './environment'
import { readEachOption, settleInstrumentations, settleUnsafe } from './assembly'
import { readOwnOrClass } from './option-kinds'
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

  it('reads a key that a prototype with no prototype and no constructor holds', () => {
    // Scenario: the lookup alone takes such a prototype for data, not for the root; whether the object is accepted is the kind check's.
    const data = Object.create(null) as Record<string, unknown>
    data['flag'] = true
    expect(readOwnOrClass(Object.create(data) as object, 'flag')).toBe(true)
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
