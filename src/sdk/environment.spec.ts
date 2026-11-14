import { getBooleanFromEnv } from '@opentelemetry/core'

import { readTelemetryEnvironment } from './environment'

describe('readTelemetryEnvironment', () => {
  describe('sdkDisabled', () => {
    it.each(['true', 'TRUE', 'True', 'true ', ' TRUE', ' true ', '\ttrue\n'])(
      'is true for OTEL_SDK_DISABLED=%p',
      (value) => {
        // Scenario: the standard kill switch is the word "true", in any letter case, with
        // surrounding whitespace ignored as the SDK ignores it. A value the library read as "on"
        // that the SDK read as "off" would load every package for an SDK that then does nothing.
        expect(readTelemetryEnvironment({ OTEL_SDK_DISABLED: value }).sdkDisabled).toBe(true)
      }
    )

    it.each([undefined, '', '  ', 'false', '1', 'yes', 'truthy', 'tru e'])(
      'is false for OTEL_SDK_DISABLED=%p',
      (value) => {
        // Scenario: only the word "true" turns the SDK off; anything else, a typo included, leaves
        // it on, as the OTel specification defines the switch.
        expect(readTelemetryEnvironment({ OTEL_SDK_DISABLED: value }).sdkDisabled).toBe(false)
      }
    )

    it.each([
      'true',
      'TRUE',
      ' true ',
      ' TRUE',
      ' True ',
      'true ',
      '\ttrue\n',
      'false',
      '1',
      'yes',
      '',
      '  ',
      'truthy',
      'tru e'
    ])('reads OTEL_SDK_DISABLED=%p as the installed SDK does', (value) => {
      // Scenario: the SDK decides for itself whether to start from the same variable, so the two
      // must never disagree. This asks the installed SDK, so a change to its parsing fails here.
      const previous = process.env['OTEL_SDK_DISABLED']
      process.env['OTEL_SDK_DISABLED'] = value
      try {
        expect(readTelemetryEnvironment({ OTEL_SDK_DISABLED: value }).sdkDisabled).toBe(
          getBooleanFromEnv('OTEL_SDK_DISABLED')
        )
      } finally {
        if (previous === undefined) delete process.env['OTEL_SDK_DISABLED']
        else process.env['OTEL_SDK_DISABLED'] = previous
      }
    })
  })

  describe('serviceName', () => {
    it('reads OTEL_SERVICE_NAME', () => {
      // Scenario: the operator's override of the service name.
      expect(readTelemetryEnvironment({ OTEL_SERVICE_NAME: 'billing' }).serviceName).toBe('billing')
    })

    it('trims the name', () => {
      // Scenario: stray whitespace around a real name is not part of the name.
      expect(readTelemetryEnvironment({ OTEL_SERVICE_NAME: ' billing ' }).serviceName).toBe(
        'billing'
      )
    })

    it.each([undefined, '', '   '])('is undefined when OTEL_SERVICE_NAME is %p', (value) => {
      // Scenario: a blank value is absent, so it never overrides the host's own name.
      expect(readTelemetryEnvironment({ OTEL_SERVICE_NAME: value }).serviceName).toBeUndefined()
    })
  })

  describe('resourceDetectors', () => {
    it.each([undefined, '', '   '])(
      'is undefined when OTEL_NODE_RESOURCE_DETECTORS is %p',
      (value) => {
        // Scenario: unset or blank means the SDK default, which is not a list.
        expect(
          readTelemetryEnvironment({ OTEL_NODE_RESOURCE_DETECTORS: value }).resourceDetectors
        ).toBeUndefined()
      }
    )

    it('splits, trims and keeps the names in order', () => {
      // Scenario: the comma-separated form the OTel SDK accepts.
      expect(
        readTelemetryEnvironment({ OTEL_NODE_RESOURCE_DETECTORS: 'process, host ,os' })
          .resourceDetectors
      ).toEqual(['process', 'host', 'os'])
    })

    it('is an empty list, not undefined, when only separators are given', () => {
      // Scenario: a set but empty selection selects nothing, as in the SDK.
      expect(
        readTelemetryEnvironment({ OTEL_NODE_RESOURCE_DETECTORS: ',,' }).resourceDetectors
      ).toEqual([])
    })
  })

  describe('exporter lists', () => {
    it('splits, trims and keeps the names in order', () => {
      // Scenario: the comma-separated form the OTel SDK itself accepts.
      const env = readTelemetryEnvironment({
        OTEL_METRICS_EXPORTER: 'otlp, console',
        OTEL_LOGS_EXPORTER: ' none '
      })
      expect(env.metricsExporters).toEqual(['otlp', 'console'])
      expect(env.logsExporters).toEqual(['none'])
    })

    it.each([undefined, '', ' ', ',,', ' , '])('is empty for %p', (value) => {
      // Scenario: no exporter named, however the blank is spelled.
      const env = readTelemetryEnvironment({
        OTEL_METRICS_EXPORTER: value,
        OTEL_LOGS_EXPORTER: value
      })
      expect(env.metricsExporters).toEqual([])
      expect(env.logsExporters).toEqual([])
    })
  })

  describe('batchSpanProcessor', () => {
    it('maps every OTEL_BSP_* variable that holds a usable number', () => {
      // Scenario: the four standard tuning variables, each mapped to its processor option.
      const env = readTelemetryEnvironment({
        OTEL_BSP_MAX_QUEUE_SIZE: '4096',
        OTEL_BSP_SCHEDULE_DELAY: '1500',
        OTEL_BSP_EXPORT_TIMEOUT: '20000',
        OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '256'
      })
      expect(env.batchSpanProcessor).toEqual({
        maxQueueSize: 4096,
        scheduledDelayMillis: 1500,
        exportTimeoutMillis: 20000,
        maxExportBatchSize: 256
      })
    })

    it('holds no key for a variable that is unset', () => {
      // Scenario: an absent variable keeps the SDK's own default, so the key must be absent
      // rather than present with an undefined value.
      expect(readTelemetryEnvironment({}).batchSpanProcessor).toEqual({})
    })

    it.each(['abc', '0', '-5', '', ' ', 'Infinity', 'NaN'])(
      'ignores the unusable value %p',
      (value) => {
        // Scenario: blank, non-numeric, non-positive and infinite values are ignored, so the SDK
        // default applies.
        const env = readTelemetryEnvironment({
          OTEL_BSP_MAX_QUEUE_SIZE: value,
          OTEL_BSP_SCHEDULE_DELAY: value,
          OTEL_BSP_EXPORT_TIMEOUT: value,
          OTEL_BSP_MAX_EXPORT_BATCH_SIZE: value
        })
        expect(env.batchSpanProcessor).toEqual({})
      }
    )

    it.each([
      ['OTEL_BSP_SCHEDULE_DELAY', 'scheduledDelayMillis'],
      ['OTEL_BSP_EXPORT_TIMEOUT', 'exportTimeoutMillis']
    ])('accepts %s at the largest value a timer holds', (name, key) => {
      // Scenario: the ceiling is inclusive, so 2147483647 ms, about 24.8 days, is still a value.
      const env = readTelemetryEnvironment({ [name]: '2147483647' })
      expect(env.batchSpanProcessor).toEqual({ [key]: 2147483647 })
      expect(env.oversizedTimers).toEqual([])
    })

    it.each([
      ['OTEL_BSP_SCHEDULE_DELAY', 'OTEL_BSP_SCHEDULE_DELAY'],
      ['OTEL_BSP_EXPORT_TIMEOUT', 'OTEL_BSP_EXPORT_TIMEOUT']
    ])('ignores %s above the largest value a timer holds, and names it', (name) => {
      // Scenario: Node clamps a longer timer to 1 ms, so a delay of 3000000000 exported once per
      // span. The value is ignored, the SDK default applies, and the variable is named so the
      // start can say so.
      const env = readTelemetryEnvironment({ [name]: '3000000000' })
      expect(env.batchSpanProcessor).toEqual({})
      expect(env.oversizedTimers).toEqual([name])
    })

    it('names each oversized timer once, in a stable order', () => {
      // Scenario: both timers are too long.
      const env = readTelemetryEnvironment({
        OTEL_BSP_EXPORT_TIMEOUT: '2147483648',
        OTEL_BSP_SCHEDULE_DELAY: '1e12'
      })
      expect(env.oversizedTimers).toEqual(['OTEL_BSP_SCHEDULE_DELAY', 'OTEL_BSP_EXPORT_TIMEOUT'])
    })

    it('does not apply the timer ceiling to the sizes', () => {
      // Scenario: a queue or a batch size is not fed to a timer, so a large one is the host's call.
      const env = readTelemetryEnvironment({
        OTEL_BSP_MAX_QUEUE_SIZE: '3000000000',
        OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '3000000000'
      })
      expect(env.batchSpanProcessor).toEqual({
        maxQueueSize: 3000000000,
        maxExportBatchSize: 3000000000
      })
      expect(env.oversizedTimers).toEqual([])
    })

    it.each(['abc', '0', '-5', 'Infinity'])(
      'does not name a timer whose value is unusable for another reason (%p)',
      (value) => {
        // Scenario: only a value that is too long is reported; the others keep being ignored quietly.
        const env = readTelemetryEnvironment({
          OTEL_BSP_SCHEDULE_DELAY: value,
          OTEL_BSP_EXPORT_TIMEOUT: value
        })
        expect(env.oversizedTimers).toEqual([])
      }
    )

    it('keeps the variables independent of each other', () => {
      // Scenario: one usable and three unusable values map only the usable one.
      const env = readTelemetryEnvironment({
        OTEL_BSP_EXPORT_TIMEOUT: '5000',
        OTEL_BSP_MAX_QUEUE_SIZE: 'abc'
      })
      expect(env.batchSpanProcessor).toEqual({ exportTimeoutMillis: 5000 })
    })
  })

  it('reads the process environment when no source is given', () => {
    // Scenario: the default parameter is the one place the library names process.env.
    const previous = process.env['OTEL_SERVICE_NAME']
    process.env['OTEL_SERVICE_NAME'] = 'from-process'
    try {
      expect(readTelemetryEnvironment().serviceName).toBe('from-process')
    } finally {
      if (previous === undefined) delete process.env['OTEL_SERVICE_NAME']
      else process.env['OTEL_SERVICE_NAME'] = previous
    }
  })
})
