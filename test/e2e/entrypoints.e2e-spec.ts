import * as nest from '@bymax-one/nest-telemetry/nest'
import * as register from '@bymax-one/nest-telemetry/register'
import * as sdk from '@bymax-one/nest-telemetry'

describe('entry points', () => {
  it('resolves each published subpath through its alias', () => {
    // Scenario: a consumer imports the package root, `./register` and `./nest`; each alias must
    // reach a module of its own subpath.
    expect(typeof sdk.startTelemetry).toBe('function')
    expect(Object.keys(register)).toEqual([])
    expect(typeof nest.TelemetryModule).toBe('function')
    // Reading every export resolves each re-export to the real value.
    expect(Object.values(nest)).toHaveLength(6)
    expect(nest.TELEMETRY_FLUSH_FAILED_KEY).toBe('TRACING_FLUSH_FAILED')
    expect(nest.TELEMETRY_SHUTDOWN_TIMEOUT_KEY).toBe('TRACING_SHUTDOWN_TIMEOUT')
    expect(nest.TELEMETRY_EXPORT_FAILED_KEY).toBe('TRACING_EXPORT_FAILED')
  })
})
