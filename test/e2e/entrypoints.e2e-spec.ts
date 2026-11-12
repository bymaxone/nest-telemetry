import * as sdk from '@bymax-one/nest-telemetry'
import * as register from '@bymax-one/nest-telemetry/register'
import { scaffoldMarker as fromNest } from '@bymax-one/nest-telemetry/nest'

describe('entry points', () => {
  it('resolves each published subpath through its alias', () => {
    // Scenario: a consumer imports the package root, `./register` and `./nest`; each alias must
    // reach a module of its own subpath.
    expect(typeof sdk.startTelemetry).toBe('function')
    expect(Object.keys(register)).toEqual([])
    expect(fromNest()).toBe('nest-telemetry')
  })
})
