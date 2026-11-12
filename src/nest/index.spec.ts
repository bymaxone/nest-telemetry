import * as entry from './index'

describe('nest entry point', () => {
  it('exposes exactly the scaffold marker, and it works', () => {
    // Scenario: the barrel is loaded the way a consumer loads it; its export list is the
    // public surface of this subpath, so an added or dropped name must change this test, and
    // calling the export proves the re-export resolves to the real function.
    expect(Object.keys(entry)).toEqual(['scaffoldMarker'])
    expect(entry.scaffoldMarker()).toBe('nest-telemetry')
  })
})
