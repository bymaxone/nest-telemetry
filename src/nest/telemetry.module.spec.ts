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

  it('is global, so its hook shuts down among the last modules to close', () => {
    // Scenario: Nest runs shutdown hooks in reverse order of distance and gives a global module
    // the largest distance, so the span flush runs after the hooks of ordinary modules, whose
    // last spans it would otherwise drop.
    expect(Reflect.getMetadata('__module:global__', TelemetryModule)).toBe(true)
  })
})
