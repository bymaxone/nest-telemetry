import * as entry from './index'

describe('sdk entry point', () => {
  it('exposes exactly the scaffold marker', () => {
    // Scenario: the barrel is loaded the way a consumer loads it; its export list is the
    // public surface of this subpath, so an added or dropped name must change this test.
    expect(Object.keys(entry)).toEqual(['scaffoldMarker'])
  })
})
