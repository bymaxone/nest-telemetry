/**
 * @fileoverview Tests the failure description: only a short code and an OpenTelemetry package name
 * leave an error, never its message, its stack or anything the host supplied.
 * @layer sdk
 */
import { codeOf, describeFailure } from './error-code'

const throwing = {
  toString: (): never => {
    throw new Error('boom')
  }
}

describe('codeOf', () => {
  it.each([
    ['a plain code', { code: 'ECONNREFUSED' }, 'ECONNREFUSED'],
    ['a code of one character', { code: 'E' }, 'E'],
    ['a code of 40 characters', { code: 'A'.repeat(40) }, 'A'.repeat(40)],
    ['a numeric code', { code: 503 }, '503'],
    ['an empty code', { code: '' }, 'UNKNOWN'],
    ['a code of 41 characters', { code: 'A'.repeat(41) }, 'UNKNOWN'],
    ['a lower-case code', { code: 'econnrefused' }, 'UNKNOWN'],
    ['a code with a trailing newline', { code: 'SAFE\n' }, 'UNKNOWN'],
    ['a code with a trailing carriage return and newline', { code: 'SAFE\r\n' }, 'UNKNOWN'],
    ['a code that is a URL', { code: 'http://user:hunter2@host/' }, 'UNKNOWN'],
    ['a code object whose toString throws', { code: throwing }, 'UNKNOWN'],
    ['a code object without a prototype', { code: Object.create(null) }, 'UNKNOWN'],
    [
      'a code object that converts to a valid token',
      { code: { toString: (): string => 'ECONNREFUSED' } },
      'UNKNOWN'
    ],
    ['no code', {}, 'UNKNOWN']
  ])('reads %s', (_what, error, expected) => {
    // Scenario: only an upper-case token of 1 to 40 characters, a string or a number, is a code.
    expect(codeOf(error)).toBe(expected)
  })

  it.each([
    ['a string', 'plain text'],
    ['undefined', undefined],
    ['null', null]
  ])('reads %s as no code', (_what, thrown) => {
    // Scenario: a thrown value that is not an error has no code.
    expect(codeOf(thrown)).toBe('UNKNOWN')
  })

  it('reads a code getter that throws as no code', () => {
    // Scenario: reading the code must never throw from inside the report of a failure.
    const error = Object.defineProperty({}, 'code', {
      get: () => {
        throw new Error('boom')
      }
    })
    expect(codeOf(error)).toBe('UNKNOWN')
  })
})

describe('describeFailure', () => {
  it('names the code and the OpenTelemetry package a missing peer names', () => {
    // Scenario: a peer that is not installed is the usual cause of a failed start, and the package
    // is what the reader needs; the rest of the message, the path included, is not written.
    const error = Object.assign(
      new Error("Cannot find package '@opentelemetry/sdk-node' imported from /srv/app/preload.mjs"),
      { code: 'ERR_MODULE_NOT_FOUND' }
    )
    expect(describeFailure(error)).toBe(
      'code ERR_MODULE_NOT_FOUND, package @opentelemetry/sdk-node'
    )
  })

  it('names only the code when the message names no OpenTelemetry package', () => {
    // Scenario: any other failure is described by its code alone.
    expect(describeFailure(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(
      'code ECONNREFUSED'
    )
    expect(describeFailure(new Error('refused'))).toBe('code UNKNOWN')
  })

  it.each([
    ['a thrown string', 'plain text'],
    ['an object with a message that is not text', { message: 42 }],
    [
      'an object whose message is not text but prints as a package name',
      { message: { toString: (): string => '@opentelemetry/api' } }
    ],
    [
      'an object whose message getter throws',
      Object.defineProperty({}, 'message', {
        get: () => {
          throw new Error('boom')
        }
      })
    ]
  ])('describes %s by its code alone', (_what, thrown) => {
    // Scenario: nothing about the value is read but its code and a package name in a text message.
    expect(describeFailure(thrown)).toBe('code UNKNOWN')
  })

  it('writes neither a credentialed endpoint nor a header the message quotes', () => {
    // Scenario: an SDK or loader error can quote its configuration; none of it is written.
    const error = Object.assign(
      new Error(
        'POST http://user:hunter2@collector.example/v1/traces failed, header Authorization: Bearer s3cret'
      ),
      { code: 'ECONNREFUSED' }
    )
    const text = describeFailure(error)
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('s3cret')
    expect(text).not.toContain('collector.example')
  })

  it('takes only the package name from a message that quotes more', () => {
    // Scenario: the match is the package name of the OpenTelemetry scope, and the rest of the text,
    // a query token included, is not written.
    expect(describeFailure(new Error('see https://x.example/@opentelemetry/api?token=abc'))).toBe(
      'code UNKNOWN, package @opentelemetry/api'
    )
  })
})
