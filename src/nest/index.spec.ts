import * as entry from './index'

describe('nest entry point', () => {
  it('exposes exactly the module, the hook, the logger token and the failure key', () => {
    // Scenario: the barrel is loaded the way a consumer loads it; its export list is the public
    // surface of this subpath, so an added or dropped name must change this test.
    expect(Object.keys(entry).sort()).toEqual([
      'TELEMETRY_FLUSH_FAILED_KEY',
      'TELEMETRY_LOGGER',
      'TelemetryModule',
      'TelemetryShutdownHook'
    ])
    // Reading every export resolves each re-export to the real value.
    expect(Object.values(entry)).toHaveLength(4)
  })
})
