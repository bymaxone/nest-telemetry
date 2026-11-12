import * as entry from './index'

describe('register entry point types', () => {
  it('exports nothing, because the subpath is a preload', () => {
    // Scenario: `./register` is imported for its effect, so its type surface is empty; an added
    // export would change what a consumer can import from it.
    expect(Object.keys(entry)).toEqual([])
  })
})
