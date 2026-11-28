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
function fakeSpan(message: unknown, ...events: (Attributes | undefined)[]): FakeSpan {
  const span = {
    status: { code: 2, message } as SpanStatus,
    events: events.map((attributes) => (attributes === undefined ? {} : { attributes })),
    setStatus(status: SpanStatus): void {
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
    "Unexpected token '😀', \"😀hunter2",
    "Unexpected token 'export'\nUnexpected token 'p', \"password=hunter2"
  ])('redacts a message cut before its ending: %j', (text) => {
    // Scenario: a host shortened the message, so only its start identifies it.
    expect(redactParseErrorText(text)).toBe('[redacted]')
  })

  it.each([
    "Unexpected token 'x', \"x is not valid JSON hunter2",
    "Unexpected token 'x', \"x is not valid JSON is not valid JSON hunter2",
    "Unexpected token 'x', \"x is not valid JSON\nhunter2",
    'Unexpected token \'x\', "x" is not valid JSON (request hunter2)',
    "Unexpected token 'export'; Unexpected token 'x', \"x is not valid JSON hunter2"
  ])('keeps nothing after the ending of a message that names a token: %j', (text) => {
    // Scenario: a message cut short whose quoted input holds the ending words looks like a whole
    // one, so only stack frames may follow the ending of a message that names a token.
    expect(redactParseErrorText(text)).toBe('[redacted] is not valid JSON')
  })

  it.each([
    ['\n    at hunter2', ''],
    ['\n    at a (b.js:1:2)\nhunter2', '\n    at a (b.js:1:2)'],
    ['\n    at a (b.js:1:2)\n    at hunter2\n    at c (d.js:3:4)', '\n    at a (b.js:1:2)'],
    [' hunter2\n    at a (b.js:1:2)', '\n    at a (b.js:1:2)']
  ])('keeps only the frame lines right after a token message: %j', (rest, frames) => {
    // Scenario: the input of a cut message imitates the start of a stack.
    expect(redactParseErrorText(`Unexpected token 'x', "x is not valid JSON${rest}`)).toBe(
      `[redacted] is not valid JSON${frames}`
    )
  })

  it('keeps what follows the ending of a message that names no token', () => {
    // Scenario: V8 quotes a whole short source without naming a token.
    expect(redactParseErrorText('"[object Object]" is not valid JSON (config)')).toBe(
      '[redacted] is not valid JSON (config)'
    )
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

describe('redactStackText, with a message that also occurs in a frame', () => {
  const frames = [
    '    at boot (file:///app/main.js:3:10)',
    '    at Module._compile (node:internal/modules/cjs/loader:1929:14)'
  ].join('\n')

  it.each(['boot', 'node', 'main', '10', 'at', ')'])('keeps every frame for %j', (message) => {
    // Scenario: the message is a word of a path, a function name or a position.
    expect(redactStackText(`Error: ${message}\n${frames}`, message)).toBe(
      `Error: [redacted]\n${frames}`
    )
  })

  it('keeps every frame when only a frame holds the recorded message', () => {
    // Scenario: the message changed after the stack was captured.
    expect(redactStackText(`Error: hunter2\n${frames}`, 'node')).toBe(
      `Error: [redacted]\n${frames}`
    )
  })

  it('takes a message with no class name before it', () => {
    // Scenario: the stack starts with the message itself.
    expect(redactStackText(`boot\n${frames}`, 'boot')).toBe(`[redacted]\n${frames}`)
  })

  it.each(['\n    at hunter2:1:1', '    at hunter2:1:1'])(
    'drops a message that imitates a frame: %j',
    (message) => {
      // Scenario: the message starts like a frame, on the header line or right below it.
      expect(redactStackText(`Error: ${message}\n${frames}`, message)).toBe(
        `Error: [redacted]\n${frames}`
      )
    }
  )

  it('counts the header line even when it starts like a frame', () => {
    // Scenario: a stack with no class name, whose message is two lines that imitate frames.
    const message = '    at q\n    at hunter2:1:1'

    expect(redactStackText(`${message}\n${frames}`, message)).toBe(`[redacted]\n${frames}`)
  })

  it('cuts after a later copy of the message that is not a frame', () => {
    // Scenario: the stack repeats the message under its header, imitation line included.
    const message = 'bad\n    at hunter2:1:1'

    expect(redactStackText(`Error: ${message}\nCaused by: ${message}\n${frames}`, message)).toBe(
      `Error: [redacted]\n${frames}`
    )
  })
})

describe('redactStackText, with a stack cut short inside its message', () => {
  it.each([
    ['after a line written like a frame', 'Error: x\n    at hunter2:1:2'],
    ['in the middle of that line', 'Error: x\n    at hunter2:1:2)']
  ])('keeps no line of a stack cut %s', (_where, stack) => {
    // Scenario: a length limit cuts message and stack, so the stack no longer holds the message.
    expect(redactStackText(stack, `${stack.slice('Error: '.length)}\nand the rest`)).toBe(
      'Error: [redacted]'
    )
  })

  it('keeps no line when only the stack was cut', () => {
    // Scenario: a limit longer than the message but shorter than the header plus the message.
    const whole = 'x\n    at hunter2:1:2\nz'

    expect(redactStackText('Error: x\n    at hunter2:1:2', whole)).toBe('Error: [redacted]')
  })

  it('keeps no line of a cut stack whose error name holds a colon and a space', () => {
    // Scenario: the first `: ` of the header is part of the name, so the message starts later.
    const stack = 'Foo: Bar: x\n    at hunter2:1:2'

    expect(redactStackText(stack, 'x\n    at hunter2:1:2\nand the rest')).toBe('[redacted]')
  })

  it.each([
    [256, '[redacted]'],
    [257, '[redacted]\n    at hunter2:1:2']
  ])('reads a cut stack under a class name of %i characters', (length, expected) => {
    // Scenario: the search is bounded, so a longer name is not recognised as a header.
    const stack = `${'N'.repeat(length)}: x\n    at hunter2:1:2`

    expect(redactStackText(stack, 'x\n    at hunter2:1:2\nand the rest')).toBe(expected)
  })
})

describe('where redactStackText and redactParseErrorText look', () => {
  it.each([["Unexpected token 'abc' in list 'a', 'b'"], ["Unexpected token ', expected a name"]])(
    'does not take %j for a message that names a token',
    (text) => {
      // Scenario: the comma that ends a quoted token comes right after it, not before or far from it.
      expect(redactParseErrorText(text)).toBe(text)
    }
  )

  it('takes a stack as cut in its message only after a `: ` of its header', () => {
    // Scenario: with no `: ` in the stack, a later part of its first line is not a message start.
    const stack = 'XXopen the file\n    at f (a:1:1)'

    expect(redactStackText(stack, 'open the file\n    at f (a:1:1) for a user')).toBe(
      '[redacted]\n    at f (a:1:1)'
    )
  })

  it('finds a cut message behind an empty class name', () => {
    // Scenario: the `: ` that starts the message is the first thing in the stack.
    const stack = ': open the\n    at f (a:1:1)'

    expect(redactStackText(stack, 'open the\n    at f (a:1:1) file')).toBe('[redacted]')
  })

  it('reads an indented first line as the header and not as a frame', () => {
    // Scenario: a first line a frame can be read in only from its second character, and one below.
    const stack = '     at SECRET\n    at hidden (a:1:1)\n    at real (a:1:1)'

    expect(redactStackText(stack, 'SECRET\n    at hidden (a:1:1)')).toBe(
      '[redacted]\n    at real (a:1:1)'
    )
  })

  it('keeps a frame that holds the message under an empty header line', () => {
    // Scenario: a function named like the message, in a stack whose first line is empty.
    expect(redactStackText('\n    at open (a:1:1)', 'open')).toBe('[redacted]\n    at open (a:1:1)')
  })
})

describe('redactStackText, with a long stack', () => {
  const header = 'Error: hunter2'
  const frame = '    at boot (file:///app/main.js:3:10)'

  /** A stack of exactly `length` characters that ends in one frame. */
  function stackOf(length: number): string {
    return `${header}${'x'.repeat(length - header.length - frame.length - 1)}\n${frame}`
  }

  it('searches a stack of 32,768 characters and keeps its frames', () => {
    // Scenario: the longest stack that is searched for its message.
    expect(redactStackText(stackOf(32_768), 'hunter2')).toBe(`Error: [redacted]\n${frame}`)
  })

  it('keeps no frame of a longer stack that has a message to look for', () => {
    // Scenario: the search could stall the host, so nothing of the stack is kept.
    expect(redactStackText(stackOf(32_769), 'hunter2')).toBe('Error: [redacted]')
  })

  it('keeps the frames of a longer stack when there is no message to look for', () => {
    // Scenario: reading the trailing frames needs no search.
    expect(redactStackText(stackOf(32_769), undefined)).toBe(`Error: [redacted]\n${frame}`)
  })
})

describe('createExceptionTextRedactor', () => {
  it.each([false, true])(
    'redacts a stack recorded without a message (every message: %p)',
    (every) => {
      // Scenario: an event written by hand holds a stack alone; no message attribute is added to it.
      const span = fakeSpan(undefined, {
        'exception.stacktrace': `SyntaxError: ${QUOTED}\n${FRAMES}`
      })

      end(span, every)

      const kept = every ? 'SyntaxError: [redacted]' : 'SyntaxError: [redacted] is not valid JSON'
      expect(span.events[0]?.attributes).toStrictEqual({
        'exception.stacktrace': `${kept}\n${FRAMES}`
      })
    }
  )

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

  it('scrubs each string of an array value and leaves the other elements', () => {
    // Scenario: an event added by hand may carry arrays where the SDK writes strings.
    const span = fakeSpan(undefined, {
      'exception.message': [QUOTED, 'timeout', null],
      'exception.stacktrace': [`SyntaxError: ${QUOTED}\n${FRAMES}`, 7]
    })

    end(span, false)

    expect(span.events[0]?.attributes).toEqual({
      'exception.message': ['[redacted] is not valid JSON', 'timeout', null],
      'exception.stacktrace': [`SyntaxError: [redacted] is not valid JSON\n${FRAMES}`, 7]
    })
  })

  it.each([[['hunter2']], [7], [true]])(
    'replaces a message and a stack that are %j when every message is asked for',
    (value) => {
      // Scenario: a value that is not a string cannot be read for frames, so none of it is kept.
      const span = fakeSpan(undefined, {
        'exception.message': value,
        'exception.stacktrace': value
      })

      end(span, true)

      expect(span.events[0]?.attributes).toEqual({
        'exception.message': '[redacted]',
        'exception.stacktrace': '[redacted]'
      })
    }
  )

  it('leaves a value that is neither a string nor an array when only parse errors are redacted', () => {
    // Scenario: a number quotes no input.
    const span = fakeSpan(undefined, { 'exception.stacktrace': 7 })

    end(span, false)

    expect(span.events[0]?.attributes).toEqual({ 'exception.stacktrace': 7 })
  })

  it('replaces the status message and removes every event when the redaction fails', () => {
    // Scenario: a value that throws when read must not reach the exporter, nor the caller of end().
    const broken = {
      'exception.message': 'hunter2',
      get 'exception.stacktrace'(): string {
        throw new Error('unreadable')
      }
    }
    const span = fakeSpan('hunter2', broken, { 'exception.message': 'hunter2' }, undefined)

    expect(() => end(span, false)).not.toThrow()

    expect(span.status).toEqual({ code: 2, message: '[redacted]' })
    expect(span.events).toEqual([])
  })

  it.each([0, 1])(
    'writes no status message on a status of code %p when the redaction fails',
    (code) => {
      // Scenario: only an error status says why; an unset or ok status gains no marker and keeps no text.
      const span = fakeSpan(undefined, {
        get 'exception.message'(): string {
          throw new Error('unreadable')
        }
      })
      span.status = { code, message: 'hunter2' } as SpanStatus

      end(span, true)

      expect(span.status).toStrictEqual({ code })
      expect(span.events).toEqual([])
    }
  )

  it.each([
    [
      'ignores the call',
      (span: FakeSpan): void => {
        span.setStatus = (): void => undefined
      }
    ],
    [
      'throws',
      (span: FakeSpan): void => {
        span.setStatus = (): void => {
          throw new Error('unwritable')
        }
      }
    ],
    [
      'holds a frozen status',
      (span: FakeSpan): void => {
        span.status = Object.freeze({ code: 2, message: 'hunter2' })
      }
    ]
  ])('replaces the status message of a span whose setStatus or status %s', (_what, alter) => {
    // Scenario: the new status does not depend on the method or on the old object.
    const span = fakeSpan('hunter2')
    alter(span)

    end(span, true)

    expect(span.status).toEqual({ code: 2, message: '[redacted]' })
  })

  it.each([
    ['frozen', Object.freeze({ 'exception.message': 'hunter2', other: 'kept' })],
    [
      'with a setter that ignores the write',
      {
        other: 'kept',
        get 'exception.message'(): string {
          return 'hunter2'
        },
        set 'exception.message'(_value: string) {
          // The write is ignored.
        }
      }
    ]
  ])('replaces a message held by attributes %s', (_what, attributes) => {
    // Scenario: the event gets new attributes, so the old object does not have to take a write.
    const span = fakeSpan(undefined, attributes)

    end(span, true)

    expect(span.events[0]?.attributes).toEqual({ 'exception.message': '[redacted]', other: 'kept' })
  })

  it('removes every event when one cannot take new attributes', () => {
    // Scenario: nothing can be written to the event itself, so it cannot stay.
    const span = fakeSpan(undefined, { 'exception.message': 'hunter2' })
    span.events[0] = Object.freeze({ attributes: { 'exception.message': 'hunter2' } })

    expect(() => end(span, true)).not.toThrow()

    expect(span.events).toEqual([])
  })

  it('removes every event when they cannot be iterated', () => {
    // Scenario: the removal does not read the events one by one.
    const span = fakeSpan('hunter2', { 'exception.message': 'hunter2' })
    span.events[Symbol.iterator] = (): never => {
      throw new Error('unreadable')
    }

    expect(() => end(span, true)).not.toThrow()

    expect(span.status).toEqual({ code: 2, message: '[redacted]' })
    expect(span.events).toHaveLength(0)
  })

  it('removes the events of a span whose status cannot be replaced', () => {
    // Scenario: one write of the fallback failing does not stop the other.
    const span = fakeSpan('hunter2', { 'exception.message': 'hunter2' })
    Object.defineProperty(span, 'status', { writable: false })

    expect(() => end(span, true)).not.toThrow()

    expect(span.events).toEqual([])
  })

  it('does not throw when neither the status nor the events take a write', () => {
    // Scenario: nothing can be removed, and the caller of end() still must not see a failure.
    const span = fakeSpan('hunter2', { 'exception.message': 'hunter2' })
    Object.defineProperty(span, 'status', { writable: false })
    Object.freeze(span.events[0])
    Object.freeze(span.events)

    expect(() => end(span, true)).not.toThrow()
  })

  it('leaves an event with no exception text as it is, frozen or not', () => {
    // Scenario: an event that holds nothing to redact is not written.
    const span = fakeSpan(undefined)
    const event = Object.freeze({ attributes: { other: 'kept' } })
    span.events.push(event)

    end(span, true)

    expect(span.events).toEqual([event])
  })

  it.each([false, true])(
    'replaces a status message that is not a string (every message: %s)',
    (everyMessage) => {
      // Scenario: a value that is not text cannot be read for input, so none of it is kept.
      const span = fakeSpan(['hunter2'])

      end(span, everyMessage)

      expect(span.status).toEqual({ code: 2, message: '[redacted]' })
    }
  )

  it.each([undefined, ''])('does not write a status message that is %j', (message) => {
    // Scenario: a span with no message keeps its status as it was.
    const span = fakeSpan(message)
    const { status } = span

    end(span, true)

    expect(span.status).toBe(status)
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
