import { scaffoldMarker as fromNest } from '@bymax-one/nest-telemetry/nest'
import { scaffoldMarker as fromRegister } from '@bymax-one/nest-telemetry/register'
import { scaffoldMarker as fromSdk } from '@bymax-one/nest-telemetry'

describe('entry points', () => {
  it('resolves the same export through the three published subpaths', () => {
    // Scenario: a consumer imports the package root, `./register` and `./nest`; each alias
    // must reach the same module so the three entries cannot drift apart in the scaffold.
    expect([fromSdk(), fromRegister(), fromNest()]).toEqual([
      'nest-telemetry',
      'nest-telemetry',
      'nest-telemetry'
    ])
  })
})
