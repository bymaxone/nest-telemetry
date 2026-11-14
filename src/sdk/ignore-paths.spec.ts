import { ignorePaths } from './ignore-paths'

describe('ignorePaths', () => {
  const probe = ignorePaths([/^\/health\/(live|ready)\/?$/, /^\/metrics\/?$/])

  it('matches a request whose path is one of the patterns', () => {
    // Scenario: a liveness probe is the traffic that must produce no span.
    expect(probe({ url: '/health/live' })).toBe(true)
  })

  it('matches the optional trailing slash the pattern allows', () => {
    // Scenario: Express serves /metrics/ exactly as /metrics, so a probe written that way is
    // excluded as well.
    expect(probe({ url: '/metrics/' })).toBe(true)
  })

  it('matches on the path alone, ignoring the query string', () => {
    // Scenario: an exclusion that a caller could switch off by appending a parameter would be an
    // exclusion in name only.
    expect(probe({ url: '/metrics?format=prometheus' })).toBe(true)
  })

  it('does not match a path the patterns do not name', () => {
    // Scenario: a real route that merely contains a probe word stays traced.
    expect(probe({ url: '/api/metrics-report' })).toBe(false)
  })

  it('does not match when the probe path appears only inside the query', () => {
    // Scenario: the query is cut before matching, so it cannot smuggle a path in.
    expect(probe({ url: '/orders?next=/health/live' })).toBe(false)
  })

  it('fails open when the request has no target', () => {
    // Scenario: the cost of a span nobody wanted is lower than silently dropping the traffic
    // least likely to be well formed.
    expect(probe({})).toBe(false)
    expect(probe({ url: undefined })).toBe(false)
  })

  it('matches nothing when no patterns are given', () => {
    // Scenario: the empty list is a valid policy of tracing everything.
    expect(ignorePaths([])({ url: '/health/live' })).toBe(false)
  })

  it('gives the same answer on every call for a pattern with the global flag', () => {
    // Scenario: a /g or /y pattern keeps lastIndex between tests and would answer true, then
    // false, for the same input; the predicate must not inherit that.
    const sticky = ignorePaths([/^\/health$/g, /^\/ready$/y])
    expect([1, 2, 3].map(() => sticky({ url: '/health' }))).toEqual([true, true, true])
    expect([1, 2, 3].map(() => sticky({ url: '/ready' }))).toEqual([true, true, true])
  })

  it('is not affected by later changes to the array it was built from', () => {
    // Scenario: the host keeps and edits its list after building the predicate.
    const patterns = [/^\/a$/]
    const predicate = ignorePaths(patterns)
    patterns.push(/^\/b$/)
    expect(predicate({ url: '/b' })).toBe(false)
    expect(predicate({ url: '/a' })).toBe(true)
  })

  describe('the length cap', () => {
    const MAX = 2048
    const pad = (length: number): string => '/' + 'a'.repeat(length - 1)

    it('still tests a path of exactly the cap', () => {
      // Scenario: the cap is inclusive, so the longest path a router accepts is still matched.
      expect(ignorePaths([/^\/a+$/])({ url: pad(MAX) })).toBe(true)
    })

    it('never ignores a path one character past the cap, and never tests it', () => {
      // Scenario: a path longer than the cap fails safe, so the request keeps its span, and the
      // patterns are not run against it at all.
      const test = jest.spyOn(RegExp.prototype, 'test')
      try {
        expect(ignorePaths([/^\/a+$/])({ url: pad(MAX + 1) })).toBe(false)
        expect(test).not.toHaveBeenCalled()
      } finally {
        test.mockRestore()
      }
    })

    it('measures the path, not the query', () => {
      // Scenario: the query is cut before the length is read, so a long query neither hides a short
      // path from the patterns nor gets a long path through.
      expect(ignorePaths([/^\/metrics$/])({ url: `/metrics?${'q'.repeat(5000)}` })).toBe(true)
      expect(ignorePaths([/^\/a+$/])({ url: `${pad(MAX + 1)}?x=1` })).toBe(false)
    })

    it('never runs a pattern with nested quantifiers on a path past the cap', () => {
      // Scenario: /^\/(a+)+$/ backtracks exponentially on a long run of a's that ends in another
      // character. The cap keeps the pattern from running on that path at all, so the bound is a count
      // of calls, not a time. The spy takes the place of the pattern's own test, so a missing cap
      // shows as a call and not as a hang, and the assertions run after the spy is released.
      const test = jest.spyOn(RegExp.prototype, 'test').mockReturnValue(false)
      let observed: { ignored: boolean; calls: number }
      try {
        const ignored = ignorePaths([/^\/(a+)+$/])({ url: `/${'a'.repeat(5000)}!` })
        observed = { ignored, calls: test.mock.calls.length }
      } finally {
        test.mockRestore()
      }
      expect(observed).toEqual({ ignored: false, calls: 0 })
    })
  })
})
