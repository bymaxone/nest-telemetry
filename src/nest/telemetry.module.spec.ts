import { TelemetryModule } from './telemetry.module'
import { TelemetryShutdownHook } from './telemetry-shutdown.hook'

describe('TelemetryModule', () => {
  it('provides the shutdown hook, which Nest finds by the provider, and nothing else', () => {
    // Scenario: importing the module is all a host does; the hook is a provider, so Nest calls its
    // onApplicationShutdown when the application closes.
    expect(Reflect.getMetadata('providers', TelemetryModule)).toEqual([TelemetryShutdownHook])
    expect(Reflect.getMetadata('imports', TelemetryModule)).toBeUndefined()
    expect(Reflect.getMetadata('exports', TelemetryModule)).toBeUndefined()
  })
})
