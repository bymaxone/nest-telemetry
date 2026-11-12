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
})
