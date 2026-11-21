/**
 * @fileoverview Tests the ignorePaths matcher on request paths: exact patterns, the optional
 * trailing slash, the global flag and the path-length cap.
 * @layer sdk
 */
import { ignorePaths } from './ignore-paths'
import { TelemetryOptionError, settleStringList } from './option-kinds'

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

  it('refuses patterns that are not a list of regular expressions', () => {
    // Scenario: a stand-in for a list, or an entry that only looks like an expression, is not accepted.
    expect(() => ignorePaths([{ source: '.*', flags: '' }] as never)).toThrow(
      'must be an array of regular expressions'
    )
    expect(() => ignorePaths('abc' as never)).toThrow('must be an array of regular expressions')
    const absent =
      'The ignorePaths patterns option must be an array of regular expressions, so the start was refused.'
    expect(() => ignorePaths(undefined as never)).toThrow(absent)
    expect(() => ignorePaths(null as never)).toThrow(absent)
  })

  it('keeps every pattern of an array subclass whose methods return nothing', () => {
    // Scenario: the copy is by index, so a subclass that hides its entries still ignores its paths.
    class Hollow extends Array<RegExp> {
      override map(): never[] {
        return []
      }
    }
    const given = new Hollow()
    given.push(/^\/health$/)
    expect(ignorePaths(given)({ url: '/health' })).toBe(true)
  })

  describe('a list whose own operation throws', () => {
    const boom = new Error('host trap failed')

    /** A list whose one operation throws; `length` answers 0 when the operation is the keys. */
    function failing(operation: 'length' | 'index' | 'keys'): RegExp[] {
      return new Proxy([/^\/a$/], {
        get: (target, key, receiver): unknown => {
          if (operation === 'length' && key === 'length') throw boom
          if (operation === 'index' && key === '0') throw boom
          if (operation === 'keys' && key === 'length') return 0
          return Reflect.get(target, key, receiver) as unknown
        },
        ownKeys: (target): ArrayLike<string | symbol> => {
          if (operation === 'keys') throw boom
          return Reflect.ownKeys(target)
        }
      })
    }

    it.each(['length', 'index', 'keys'] as const)(
      'ignorePaths refuses it with the library code and the error as the cause, for the %s',
      (operation) => {
        // Scenario: a host value must never surface a raw error from ignorePaths; the original is the cause.
        let error: unknown
        try {
          ignorePaths(failing(operation))
        } catch (caught) {
          error = caught
        }
        expect(error).toBeInstanceOf(TelemetryOptionError)
        expect(error).toMatchObject({ code: 'BYMAX_TELEMETRY_OPTION_INVALID', cause: boom })
        expect((error as Error).message).toBe(
          'The ignorePaths patterns option must be an array of regular expressions, so the start was refused.'
        )
      }
    )

    it('ignorePaths refuses a library error replayed from the keys of the list, as a host error', () => {
      // Scenario: the keys are read when the length answers 0, and a replayed library error is a host error.
      const replayed = new TelemetryOptionError('their.option', 'their words')
      const list = new Proxy([/^\/a$/], {
        get: (target, key, receiver): unknown =>
          key === 'length' ? 0 : (Reflect.get(target, key, receiver) as unknown),
        ownKeys: (): never => {
          throw replayed
        }
      })
      let error: unknown
      try {
        ignorePaths(list)
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({ option: 'ignorePaths patterns', cause: replayed })
      expect((error as Error).message).not.toContain('their')
    })

    it('ignorePaths refuses a list whose kind cannot be read, with the TypeError as the cause', () => {
      // Scenario: a revoked Proxy throws when it is asked whether it is an array.
      const { proxy, revoke } = Proxy.revocable([], {})
      revoke()
      let error: unknown
      try {
        ignorePaths(proxy)
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({ option: 'ignorePaths patterns', cause: expect.any(TypeError) })
    })

    it.each(['length', 'index'] as const)(
      'ignorePaths refuses a library error thrown by the list itself, as a host error, for the %s',
      (operation) => {
        // Scenario: a host replays an error of this library from its own list; it is a host error all the same.
        const replayed = new TelemetryOptionError('their.option', 'their words')
        const list = new Proxy([/^\/a$/], {
          get: (target, key, receiver): unknown => {
            if (key === (operation === 'length' ? 'length' : '0')) throw replayed
            return Reflect.get(target, key, receiver) as unknown
          }
        })
        let error: unknown
        try {
          ignorePaths(list)
        } catch (caught) {
          error = caught
        }
        expect(error).toMatchObject({ option: 'ignorePaths patterns', cause: replayed })
        expect((error as Error).message).not.toContain('their')
      }
    )

    it.each(['length', 'index', 'keys'] as const)(
      'a start-time list keeps the error as it was thrown, for the %s, as the README says',
      (operation) => {
        // Scenario: the control: the options of a start rethrow what the host's own list threw.
        expect(() => settleStringList('x', failing(operation))).toThrow(boom)
      }
    )
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
