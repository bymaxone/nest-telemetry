import { scaffoldMarker } from './placeholder'

describe('scaffoldMarker', () => {
  it('returns the unscoped package name', () => {
    // Scenario: the scaffold build is asked what it is; the exact name is the assertion
    // that keeps a string-literal mutant from surviving.
    expect(scaffoldMarker()).toBe('nest-telemetry')
  })
})
