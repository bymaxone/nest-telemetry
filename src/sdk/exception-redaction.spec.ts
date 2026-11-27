/**
 * @fileoverview Pins how the text of a recorded exception is redacted: the input a `JSON.parse`
 * message quotes, and every message when asked.
 * @layer sdk
 */
import type { Attributes, SpanStatus } from '@opentelemetry/api'

import {
  createExceptionTextRedactor,
  redactParseErrorText,
  redactStackText
} from './exception-redaction'

/** What the processor reads and writes of a span. */
interface FakeSpan {
  status: SpanStatus
  readonly events: { attributes?: Attributes }[]
  setStatus(status: SpanStatus): void
}

/** A span with a status message and one event per set of attributes. */
function fakeSpan(
  message: unknown,
  ...events: (Attributes | undefined)[]
): FakeSpan & { writes: number } {
  const span = {
    writes: 0,
    status: { code: 2, message } as SpanStatus,
    events: events.map((attributes) => (attributes === undefined ? {} : { attributes })),
    setStatus(status: SpanStatus): void {
      span.writes += 1
      span.status = status
    }
  }
  return span
}

/** Runs a span through the processor's ending hook. */
function end(span: FakeSpan, everyMessage: boolean): void {
  const processor = createExceptionTextRedactor(everyMessage)
  processor.onEnding?.(span as unknown as Parameters<NonNullable<typeof processor.onEnding>>[0])
}

/** The message of the error `JSON.parse` throws for an input. */
function parseMessage(input: string): string {
  try {
    JSON.parse(input)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('the input parsed')
}

const QUOTED = 'Unexpected token \'p\', "password=x" is not valid JSON'
const FRAMES = '    at JSON.parse (<anonymous>)\n    at read (file:///app/main.js:3:10)'

describe('redactParseErrorText', () => {
  it.each([
    `password=hunter2`,
    `x${'hunter2'.repeat(6)}`,
    `{"password":${'hunter2'.repeat(6)}}`,
    `{"aaaaaaaaaaaaaaaaaaaa":"b","p":hunter}`,
    `['hunter2']`,
    `😀hunter2`
  ])('keeps nothing V8 quotes of %j', (input) => {
    // Scenario: each quoting shape of the running engine, a two-unit token included.
    expect(redactParseErrorText(parseMessage(input))).toBe('[redacted] is not valid JSON')
  })

  it('keeps the class name and the frames of a stack', () => {
    // Scenario: the stack of a parse error says what was thrown and where.
    expect(redactParseErrorText(`SyntaxError: ${QUOTED}\n${FRAMES}`)).toBe(
      `SyntaxError: [redacted] is not valid JSON\n${FRAMES}`
    )
  })

  it('drops everything before the last ending when the input holds the same words', () => {
    // Scenario: the quoted input contains the words that mark the end of the message.
    const text = 'Unexpected token \'a\', "a is not valid JSON hunter2" is not valid JSON'

    expect(redactParseErrorText(text)).toBe('[redacted] is not valid JSON')
  })

  it.each([
    "Unexpected token 'p', \"password=hunter2",
    "Failed: Unexpected token '{', ...\"hunter2",
    "Unexpected token '😀', \"😀hunter2"
  ])('redacts a message cut before its ending: %j', (text) => {
    // Scenario: a host shortened the message, so only its start identifies it.
    expect(redactParseErrorText(text)).toBe('[redacted]')
  })

  it.each([
    "Unexpected token 'export'",
    'Unexpected token (1:5)',
    'Unterminated string in JSON at position 9 (line 1 column 10)',
    'Unexpected end of JSON input',
    "Expected property name or '}' in JSON at position 1",
    'connection refused'
  ])('leaves a message that quotes no input as it is: %j', (text) => {
    // Scenario: messages that carry a position or nothing at all are not touched.
    expect(redactParseErrorText(text)).toBe(text)
  })
})

describe('redactStackText', () => {
  it('keeps the class name and every kind of frame', () => {
    // Scenario: V8 ends a frame with a position, `<anonymous>`, `native` or `index N`.
    const frames = [
      '    at a (file:///app/a.js:1:2)',
      '    at /app/b.js:3:4',
      '    at JSON.parse (<anonymous>)',
      '    at Array.map (native)',
      '    at async Promise.all (index 0)'
    ].join('\n')

    expect(redactStackText(`TypeError: hunter2\n${frames}`, 'hunter2')).toBe(
      `TypeError: [redacted]\n${frames}`
    )
  })

  it('does not take a line of the recorded message for a frame', () => {
    // Scenario: the message imitates a frame right above the real ones.
    const message = 'bad\n    at hunter2:1:1'

    expect(redactStackText(`Error: ${message}\n${FRAMES}`, message)).toBe(
      `Error: [redacted]\n${FRAMES}`
    )
  })

  it.each([undefined, '', 'a message the stack does not hold', 7])(
    'keeps the trailing frames when the recorded message is %j',
    (message) => {
      // Scenario: the message changed after the stack was captured, or is not usable.
      expect(redactStackText(`Error: hunter2\nmore\n${FRAMES}`, message)).toBe(
        `Error: [redacted]\n${FRAMES}`
      )
    }
  )

  it.each([
    'hunter2',
    'password: hunter2',
    '    at hunter2:1:1',
    'Error: x\n  at two spaces:1:1',
    `Error: x\n${FRAMES}\nCaused by: hunter2`,
    'Error: x\n    at hunter2'
  ])('keeps nothing but the header of %j', (stack) => {
    // Scenario: a stack with no frame at its end, or one whose first line imitates a frame, keeps
    // no line of its own text.
    expect(redactStackText(stack, undefined)).toBe(
      stack.startsWith('Error: ') ? 'Error: [redacted]' : '[redacted]'
    )
  })
})

describe('createExceptionTextRedactor', () => {
  it('redacts the parse error of the status and of each event, and nothing else', () => {
    // Scenario: a span with two exceptions, one of which is not a parse error.
    const span = fakeSpan(
      QUOTED,
      {
        'exception.type': 'SyntaxError',
        'exception.message': QUOTED,
        'exception.stacktrace': `SyntaxError: ${QUOTED}\n${FRAMES}`
      },
      { 'exception.message': 'timeout' },
      { 'exception.message': 7 },
      undefined
    )

    end(span, false)

    expect(span.status).toEqual({ code: 2, message: '[redacted] is not valid JSON' })
    expect(span.events[0]?.attributes).toEqual({
      'exception.type': 'SyntaxError',
      'exception.message': '[redacted] is not valid JSON',
      'exception.stacktrace': `SyntaxError: [redacted] is not valid JSON\n${FRAMES}`
    })
    expect(span.events[1]?.attributes).toEqual({ 'exception.message': 'timeout' })
    expect(span.events[2]?.attributes).toEqual({ 'exception.message': 7 })
  })

  it('replaces every message, whatever its kind, and keeps the type', () => {
    // Scenario: with every message asked for, nothing the exception said remains.
    const span = fakeSpan(
      'duplicate key (hunter2)',
      {
        'exception.type': '23505',
        'exception.message': 'duplicate key (hunter2)',
        'exception.stacktrace': `error: duplicate key (hunter2)\n${FRAMES}`
      },
      { 'exception.message': 7 },
      { other: 'kept' }
    )

    end(span, true)

    expect(span.status).toEqual({ code: 2, message: '[redacted]' })
    expect(span.events[0]?.attributes).toEqual({
      'exception.type': '23505',
      'exception.message': '[redacted]',
      'exception.stacktrace': `error: [redacted]\n${FRAMES}`
    })
    expect(span.events[1]?.attributes).toEqual({ 'exception.message': '[redacted]' })
    expect(span.events[2]?.attributes).toEqual({ other: 'kept' })
  })

  it.each([undefined, '', 7])('does not write a status message that is %j', (message) => {
    // Scenario: a span with no message keeps its status as it was.
    const span = fakeSpan(message)

    end(span, true)

    expect(span.writes).toBe(0)
  })

  it('does nothing at any other step of the span', async () => {
    // Scenario: the processor exports nothing and holds nothing to flush.
    const processor = createExceptionTextRedactor(false)

    expect(() => {
      processor.onStart(undefined as never, undefined as never)
      processor.onEnd(undefined as never)
    }).not.toThrow()
    await expect(processor.shutdown()).resolves.toBeUndefined()
    await expect(processor.forceFlush()).resolves.toBeUndefined()
  })
})
