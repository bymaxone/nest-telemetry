/**
 * @fileoverview Redaction of the text of recorded exceptions: the input a `JSON.parse` message
 * quotes, always, and every exception message when the host asks for it.
 * @layer sdk
 *
 * Nothing here imports an OpenTelemetry package at runtime; the type imports are erased. A boot
 * with telemetry disabled loads this module, so it must not pull the SDK graph in.
 */
import type { Attributes, AttributeValue } from '@opentelemetry/api'
import type { SpanProcessor } from '@opentelemetry/sdk-trace'

import { resolvedPromise } from './native-promise'
import { REDACTED_QUERY_VALUE as REDACTED } from './redaction'

/** The ending of every V8 `JSON.parse` message that quotes its input. */
const PARSE_ERROR_END = 'is not valid JSON'

/**
 * The start of a V8 message that quotes a token and its input. A message cut short before its
 * ending is still recognized by it.
 */
const TOKEN_START = "Unexpected token '"

/** What follows the token in a quoting message; a JavaScript syntax error has no comma here. */
const TOKEN_END = "', "

/** A class name at the head of a stack, such as `TypeError: ` or the `error: ` of the pg driver. */
const STACK_CLASS = /^(?:[A-Za-z]{0,40}(?:Error|Exception)|error): /

/** The ending of a stack frame line: a position, or one of the places V8 names instead of one. */
const FRAME_END = /(?::\d{1,10}:\d{1,10}|<anonymous>|native|index \d{1,10})\)?$/

/**
 * The longest stack searched for its message. The search can cost the product of both lengths, and
 * it runs while a span ends.
 */
const SEARCHED_STACK_LIMIT = 32_768

/**
 * The longest class name behind which a cut message is looked for. Each `: ` up to there is tried,
 * and each try can cost the length of the stack.
 */
const CLASS_NAME_LIMIT = 256

/**
 * Removes the input that a `JSON.parse` message quotes.
 *
 * Everything up to the last `is not valid JSON` goes, whatever shape it has: the quoted input may
 * hold quotes, newlines and those very words, and a shape this library does not know must not be
 * kept. A leading class name and the ending remain. What follows the ending remains too, except
 * after a message that names a token: cut short, with those words in its input, it looks like a
 * whole one, so only stack frames are kept. A token message cut before any ending is redacted
 * whole, but for the class name.
 *
 * @param text - A status message, an exception message or a stack.
 * @returns The text without the quoted input, or the same text when it quotes none.
 */
export function redactParseErrorText(text: string): string {
  const named = namesToken(text)
  const parts = text.split(PARSE_ERROR_END)
  if (parts.length === 1) return named ? `${classHead(text)}${REDACTED}` : text
  const rest = parts[parts.length - 1] as string
  const kept = named ? leadingFrames(rest) : rest
  return `${classHead(text)}${REDACTED} ${PARSE_ERROR_END}${kept}`
}

/** Whether any part of a text is the start of a message that quotes a token. */
function namesToken(text: string): boolean {
  let named = false
  for (
    let at = text.indexOf(TOKEN_START);
    at >= 0 && !named;
    at = text.indexOf(TOKEN_START, at + 1)
  ) {
    // The token is one character, two UTF-16 units at most, so its end is found right after it.
    const after = at + TOKEN_START.length
    named = text.slice(after + 1, after + 5).includes(TOKEN_END)
  }
  return named
}

/** The unbroken run of frame lines that starts on the line after the first one, or nothing. */
function leadingFrames(text: string): string {
  const lines = text.split('\n')
  let frames = ''
  for (let at = 1; at < lines.length && isFrame(lines[at] as string); at += 1) {
    frames += `\n${lines[at] as string}`
  }
  return frames
}

/**
 * Removes the message from a stack and keeps the frames under a redacted header.
 *
 * The frames are the unbroken run of frame lines at the end. When the recorded message is found in
 * the stack, outside the frame lines, nothing up to the end of its last such copy can count as a
 * frame, so a message that imitates one goes too. A copy inside a frame, such as a function or a
 * file named like the message, is the frame's own text. A stack over {@link SEARCHED_STACK_LIMIT}
 * with a message to look for keeps no frames, nor does a stack found cut in its message.
 *
 * @param stack - The recorded stack.
 * @param message - The recorded message, when it is a string.
 * @returns The class name of the stack, when it has one, `[redacted]`, and the frames.
 */
export function redactStackText(stack: string, message: unknown): string {
  let rest = stack
  if (typeof message === 'string' && message !== '') {
    if (stack.length > SEARCHED_STACK_LIMIT || cutInMessage(stack, message)) {
      return `${classHead(stack)}${REDACTED}`
    }
    const at = lastOutsideFrames(stack, message)
    if (at >= 0) rest = stack.slice(at + message.length)
  }
  const lines = rest.split('\n')
  let first = lines.length
  while (first > 1 && isFrame(lines[first - 1] as string)) first -= 1
  let redacted = `${classHead(stack)}${REDACTED}`
  for (let at = first; at < lines.length; at += 1) redacted += `\n${lines[at] as string}`
  return redacted
}

/**
 * Whether a stack ends inside its message, as a length limit leaves it: what follows its header is
 * a start of the message, and a line there written like a frame is still message. The class name may
 * hold `: ` itself, so the message is looked for after each one that a name of up to
 * {@link CLASS_NAME_LIMIT} characters can end at.
 */
function cutInMessage(stack: string, message: string): boolean {
  for (
    let at = stack.indexOf(': ');
    at >= 0 && at <= CLASS_NAME_LIMIT;
    at = stack.indexOf(': ', at + 1)
  ) {
    if (message.startsWith(stack.slice(at + 2))) return true
  }
  return false
}

/** Where the last copy of the message that does not start on a frame line is, or -1. */
function lastOutsideFrames(stack: string, message: string): number {
  let last = -1
  // The start of the line that holds the copy, and the end of that line.
  let line = 0
  let newline = stack.indexOf('\n')
  for (let at = stack.indexOf(message); at >= 0; at = stack.indexOf(message, at + 1)) {
    while (newline >= 0 && newline < at) {
      line = newline + 1
      newline = stack.indexOf('\n', line)
    }
    // The first line is the header of the stack, whatever it looks like.
    if (line === 0 || !stack.startsWith('    at ', line)) last = at
  }
  return last
}

/** The class name a stack or a message starts with, its colon included, or nothing. */
function classHead(text: string): string {
  return STACK_CLASS.test(text) ? text.slice(0, text.indexOf(': ') + 2) : ''
}

/** Whether a line of a stack is a frame. */
function isFrame(line: string): boolean {
  return line.startsWith('    at ') && FRAME_END.test(line)
}

/** A span as the ending hook receives it. */
type EndingSpan = Parameters<NonNullable<SpanProcessor['onEnding']>>[0]

/** Removes the quoted input from a string, or from each string of an array. */
function redactParseErrorValue(value: AttributeValue): AttributeValue {
  if (typeof value === 'string') return redactParseErrorText(value)
  if (!Array.isArray(value)) return value
  const elements: readonly unknown[] = value
  return elements.map((element) =>
    typeof element === 'string' ? redactParseErrorText(element) : element
  ) as AttributeValue
}

/** Redacts the status message and the exception attributes of each event of a span. */
function redactSpanText(span: EndingSpan, everyMessage: boolean): void {
  const { code, message } = span.status
  if (typeof message === 'string' && message !== '') {
    span.setStatus({ code, message: everyMessage ? REDACTED : redactParseErrorText(message) })
  }
  for (const { attributes } of span.events) {
    if (attributes === undefined) continue
    const recorded = attributes['exception.message']
    const stack = attributes['exception.stacktrace']
    // The stack is read against the recorded message, so it is redacted before the message is.
    if (stack !== undefined) {
      if (!everyMessage) attributes['exception.stacktrace'] = redactParseErrorValue(stack)
      else {
        // Frames can be told apart only in a string.
        attributes['exception.stacktrace'] =
          typeof stack === 'string' ? redactStackText(stack, recorded) : REDACTED
      }
    }
    if (recorded === undefined) continue
    attributes['exception.message'] = everyMessage ? REDACTED : redactParseErrorValue(recorded)
  }
}

/** Runs one step of the fallback; what it throws must not reach the caller of `Span.end()`. */
function attempt(step: () => void): void {
  try {
    step()
  } catch {
    // Nothing more can be removed through this step, and the host must not see the failure.
  }
}

/** Fails closed: replaces the status message and removes every exception attribute. */
function dropExceptionText(span: EndingSpan): void {
  // Written to the status itself, because `setStatus` may be what failed.
  attempt(() => {
    span.status.message = REDACTED
  })
  for (const event of span.events) {
    attempt(() => {
      const held: Attributes = event.attributes ?? {}
      for (const key of Object.keys(held)) {
        if (key.startsWith('exception.')) delete held[key]
      }
    })
  }
}

/**
 * Creates the span processor that redacts the exception text of every span as it ends: the status
 * message and the `exception.message` and `exception.stacktrace` of each event. The type of the
 * exception is not touched. When the redaction itself fails, the status message is replaced and
 * every `exception.*` attribute is removed.
 *
 * It uses `onEnding`, which `@opentelemetry/sdk-trace` marks experimental.
 *
 * @param everyMessage - Replaces every message, not only the input a parse error quotes.
 * @returns The span processor.
 */
export function createExceptionTextRedactor(everyMessage: boolean): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnding: (span): void => {
      try {
        redactSpanText(span, everyMessage)
      } catch {
        dropExceptionText(span)
      }
    },
    onEnd: () => undefined,
    shutdown: resolvedPromise,
    forceFlush: resolvedPromise
  }
}
