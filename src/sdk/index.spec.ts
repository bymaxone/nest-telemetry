import * as entry from './index'

describe('sdk entry point', () => {
  it('exposes exactly the public runtime API', () => {
    // Scenario: the barrel is loaded the way a consumer loads it; its export list is the public
    // surface of this subpath, so an added or dropped name must change this test.
    expect(Object.keys(entry).sort()).toEqual([
      'DEFAULT_REDACTED_QUERY_PARAMS',
      'ignorePaths',
      'shutdownTelemetry',
      'startTelemetry'
    ])
  })

  it('re-exports the real implementations, not stand-ins', () => {
    // Scenario: calling the re-exports proves each getter resolves to the working function.
    expect(entry.ignorePaths([/^\/a$/])({ url: '/a' })).toBe(true)
    expect(entry.DEFAULT_REDACTED_QUERY_PARAMS).toContain('token')
    expect(typeof entry.startTelemetry).toBe('function')
    expect(typeof entry.shutdownTelemetry).toBe('function')
  })
})
