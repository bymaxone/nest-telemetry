import * as sdk from '@bymax-one/nest-telemetry'
import { scaffoldMarker as fromNest } from '@bymax-one/nest-telemetry/nest'
import { scaffoldMarker as fromRegister } from '@bymax-one/nest-telemetry/register'

describe('entry points', () => {
  it('resolves each published subpath through its alias', () => {
    // Scenario: a consumer imports the package root, `./register` and `./nest`; each alias must
    // reach a module of its own subpath.
    expect(typeof sdk.startTelemetry).toBe('function')
    expect([fromRegister(), fromNest()]).toEqual(['nest-telemetry', 'nest-telemetry'])
  })
})
