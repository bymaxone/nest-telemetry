import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { AttributeValue, Attributes } from '@opentelemetry/api'

import {
  DEFAULT_REDACTED_QUERY_PARAMS,
  REDACTED_QUERY_VALUE,
  buildRedactedQueryParams,
  createUrlQueryRedactor,
  redactSpanUrlQuery,
  serializeRedisCommandName
} from './redaction'

/** A span double that records what is written through `setAttribute`. */
function fakeSpan(attributes: Attributes): {
  attributes: Attributes
  writes: [string, AttributeValue][]
  setAttribute(key: string, value: AttributeValue): void
} {
  const writes: [string, AttributeValue][] = []
  return {
    attributes,
    writes,
    setAttribute(key, value): void {
      writes.push([key, value])
    }
  }
}

describe('redactSpanUrlQuery', () => {
  it('replaces a recorded url.query with the marker', () => {
    // Scenario: the HTTP instrumentation records the raw query on a server span; the whole
    // value, whatever it holds, is replaced by a constant marker.
    const span = fakeSpan({ 'url.query': 'token=abc&x=1' })
    redactSpanUrlQuery(span)
    expect(span.writes).toEqual([['url.query', '[redacted]']])
  })

  it('writes nothing when the span has no url.query', () => {
    // Scenario: a span that never recorded a query must not gain a marker attribute.
    const span = fakeSpan({ 'http.method': 'GET' })
    redactSpanUrlQuery(span)
    expect(span.writes).toEqual([])
  })

  it('cuts the query out of url.full and keeps the path', () => {
    // Scenario: the NestJS instrumentation records the whole target under url.full; the path
    // is the operational signal and stays, the query is the secret and goes.
    const span = fakeSpan({ 'url.full': 'https://api.example.test/reset?token=abc&x=1' })
    redactSpanUrlQuery(span)
    expect(span.writes).toEqual([['url.full', 'https://api.example.test/reset']])
  })

  it.each(['http.url', 'http.target'])('cuts the query out of the legacy %s attribute', (key) => {
    // Scenario: with the legacy HTTP semantic conventions opted in, the target is also recorded
    // under http.url and http.target; they carry the same secret and get the same cut.
    const span = fakeSpan({ [key]: '/reset?token=abc' })
    redactSpanUrlQuery(span)
    expect(span.writes).toEqual([[key, '/reset']])
  })

  it('cuts at the first question mark when the value has several', () => {
    // Scenario: a second '?' inside the query must not leave the first part of the query behind.
    const span = fakeSpan({ 'url.full': '/a?b=1?c=2' })
    redactSpanUrlQuery(span)
    expect(span.writes).toEqual([['url.full', '/a']])
  })

  it('cuts a value that starts with the query separator down to an empty string', () => {
    // Scenario: the boundary where the separator is the first character.
    const span = fakeSpan({ 'url.full': '?token=abc' })
    redactSpanUrlQuery(span)
    expect(span.writes).toEqual([['url.full', '']])
  })

  it('leaves a url.full without a query untouched', () => {
    // Scenario: nothing to remove, nothing is written.
    const span = fakeSpan({ 'url.full': 'https://api.example.test/health' })
    redactSpanUrlQuery(span)
    expect(span.writes).toEqual([])
  })

  it('leaves a non-string url.full untouched', () => {
    // Scenario: an attribute of another type under the same key is not a URL to cut.
    const span = fakeSpan({ 'url.full': 42 })
    redactSpanUrlQuery(span)
    expect(span.writes).toEqual([])
  })

  it('redacts url.query and every URL attribute on the same span', () => {
    // Scenario: one span carries all four attributes; each is handled independently.
    const span = fakeSpan({
      'url.query': 'a=1',
      'url.full': '/p?a=1',
      'http.url': 'http://h/p?a=1',
      'http.target': '/p?a=1'
    })
    redactSpanUrlQuery(span)
    expect(span.writes).toEqual([
      ['url.query', '[redacted]'],
      ['url.full', '/p'],
      ['http.url', 'http://h/p'],
      ['http.target', '/p']
    ])
  })
})

describe('REDACTED_QUERY_VALUE', () => {
  it('is a constant marker rather than any part of the removed text', () => {
    // Scenario: an operator can tell a query was present without learning what it held.
    expect(REDACTED_QUERY_VALUE).toBe('[redacted]')
  })
})

describe('createUrlQueryRedactor', () => {
  it('redacts the span when it ends', () => {
    // Scenario: the processor's onEnding hook receives the mutable span and redacts it before
    // any exporting processor sees it.
    const span = fakeSpan({ 'url.query': 'a=1' })
    createUrlQueryRedactor().onEnding?.(span as never)
    expect(span.writes).toEqual([['url.query', '[redacted]']])
  })

  it('has inert start and end hooks and resolving shutdown and flush', async () => {
    // Scenario: the rest of the span-processor contract is satisfied without side effects.
    const processor = createUrlQueryRedactor()
    expect(processor.onStart(undefined as never, undefined as never)).toBeUndefined()
    expect(processor.onEnd(undefined as never)).toBeUndefined()
    await expect(processor.shutdown()).resolves.toBeUndefined()
    await expect(processor.forceFlush()).resolves.toBeUndefined()
  })
})

describe('DEFAULT_REDACTED_QUERY_PARAMS', () => {
  it('names the SDK defaults and the credential-bearing parameters, exactly', () => {
    // Scenario: supplying a list to the HTTP instrumentation REPLACES its default list, so the
    // SDK defaults must be repeated here; the whole list is pinned so a dropped or altered name
    // fails.
    expect(DEFAULT_REDACTED_QUERY_PARAMS).toEqual([
      'sig',
      'Signature',
      'AWSAccessKeyId',
      'X-Goog-Signature',
      'X-Amz-Signature',
      'X-Amz-Credential',
      'X-Amz-Security-Token',
      'token',
      'code',
      'access_token',
      'refresh_token',
      'id_token',
      'secret',
      'password',
      'api_key',
      'apikey',
      'key',
      'signature',
      'sas',
      'auth'
    ])
  })
})

describe('DEFAULT_REDACTED_QUERY_PARAMS against the installed instrumentation', () => {
  it('contains every name the HTTP instrumentation redacts by default', () => {
    // Scenario: OpenTelemetry adds a parameter to its own default list in a later release; a copy
    // compared with itself would never notice, so the list is read from the installed package.
    const dist = dirname(require.resolve('@opentelemetry/instrumentation-http'))
    const source = readFileSync(join(dist, 'internal-types.cjs'), 'utf8')
    const declared = /DEFAULT_QUERY_STRINGS_TO_REDACT\s*=\s*\[([^\]]*)\]/.exec(source)
    const names = [...(declared?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((match) => match[1])
    expect(names.length).toBeGreaterThan(0)
    expect(DEFAULT_REDACTED_QUERY_PARAMS).toEqual(expect.arrayContaining(names))
  })
})

describe('buildRedactedQueryParams', () => {
  it('returns the defaults when nothing is added', () => {
    // Scenario: the zero-argument form is the default list.
    expect(buildRedactedQueryParams([])).toEqual([...DEFAULT_REDACTED_QUERY_PARAMS])
  })

  it('appends the host names after the defaults', () => {
    // Scenario: a host adds its own secret parameter; the defaults stay in front.
    expect(buildRedactedQueryParams(['session'])).toEqual([
      ...DEFAULT_REDACTED_QUERY_PARAMS,
      'session'
    ])
  })

  it('skips a name the defaults already hold and repeats within the additions', () => {
    // Scenario: duplicates add nothing; the list stays free of repeats.
    expect(buildRedactedQueryParams(['token', 'session', 'session'])).toEqual([
      ...DEFAULT_REDACTED_QUERY_PARAMS,
      'session'
    ])
  })

  it('returns a new array each call so a caller cannot edit the defaults', () => {
    // Scenario: mutating the returned list must not change the next call's result.
    const first = buildRedactedQueryParams([])
    first.push('mutated')
    expect(buildRedactedQueryParams([])).toEqual([...DEFAULT_REDACTED_QUERY_PARAMS])
  })
})

describe('serializeRedisCommandName', () => {
  it('returns the command name and nothing else', () => {
    // Scenario: ioredis hands the serializer a command; only its name may reach db.query.text.
    expect(serializeRedisCommandName('eval')).toBe('eval')
  })
})
