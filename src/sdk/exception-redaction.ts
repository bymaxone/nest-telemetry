/**
 * @fileoverview Redaction of the text of recorded exceptions: the input a `JSON.parse` message
 * quotes, always, and every exception message when the host asks for it.
 * @layer sdk
 *
 * Nothing here imports an OpenTelemetry package at runtime; the type imports are erased. A boot
 * with telemetry disabled loads this module, so it must not pull the SDK graph in.
 */
import type { SpanProcessor } from '@opentelemetry/sdk-trace'

import { resolvedPromise } from './native-promise'
import { REDACTED_QUERY_VALUE as REDACTED } from './redaction'

/** The ending of every V8 `JSON.parse` message that quotes its input. */
const PARSE_ERROR_END = 'is not valid JSON'

/**
 * The start of the V8 messages that quote their input, up to the token. A message cut short before
 * its ending is still recognized by it.
 */
const TOKEN_START = "Unexpected token '"

/** What follows the token in a quoting message; a JavaScript syntax error has no comma here. */
const TOKEN_END = "', "

/** A class name at the head of a stack, such as `TypeError: ` or the `error: ` of the pg driver. */
const STACK_CLASS = /^(?:[A-Za-z]{0,40}(?:Error|Exception)|error): /

/** The ending of a stack frame line: a position, or one of the places V8 names instead of one. */
const FRAME_END = /(?::\d{1,10}:\d{1,10}|<anonymous>|native|index \d{1,10})\)?$/

/**
 * Removes the input that a `JSON.parse` message quotes.
 *
 * Everything up to the last `is not valid JSON` goes, whatever shape it has: the quoted input may
 * hold quotes, newlines and those very words, and a shape this library does not know must not be
 * kept. Only the class name of a stack and what follows the ending, the frames, remain. A quoting
 * message cut short before its ending is redacted from its token on.
 *
 * @param text - A status message, an exception message or a stack.
 * @returns The text without the quoted input, or the same text when it quotes none.
 */
export function redactParseErrorText(text: string): string {
  const parts = text.split(PARSE_ERROR_END)
  if (parts.length > 1) {
    return `${classHead(text)}${REDACTED} ${PARSE_ERROR_END}${parts[parts.length - 1] as string}`
  }
  const token = text.indexOf(TOKEN_START)
  // The token is one character, two UTF-16 units at most, so its end is found right after it.
  const after = token + TOKEN_START.length
  const cut = token >= 0 && text.slice(after + 1, after + 5).includes(TOKEN_END)
  return cut ? `${classHead(text)}${REDACTED}` : text
}

/**
 * Removes the message from a stack and keeps the frames under a redacted header.
 *
 * The frames are the unbroken run of frame lines at the end. When the recorded message is found in
 * the stack, nothing up to its end can count as a frame, so a message that imitates one goes too.
 *
 * @param stack - The recorded stack.
 * @param message - The recorded message, when it is a string.
 * @returns The class name of the stack, when it has one, `[redacted]`, and the frames.
 */
export function redactStackText(stack: string, message: unknown): string {
  const parts = typeof message === 'string' && message !== '' ? stack.split(message) : [stack]
  const lines = (parts[parts.length - 1] as string).split('\n')
  let first = lines.length
  while (first > 1 && isFrame(lines[first - 1] as string)) first -= 1
  let redacted = `${classHead(stack)}${REDACTED}`
  for (let at = first; at < lines.length; at += 1) redacted += `\n${lines[at] as string}`
  return redacted
}

/** The class name a stack or a message starts with, its colon included, or nothing. */
function classHead(text: string): string {
  return STACK_CLASS.test(text) ? text.slice(0, text.indexOf(': ') + 2) : ''
}

/** Whether a line of a stack is a frame. */
function isFrame(line: string): boolean {
  return line.startsWith('    at ') && FRAME_END.test(line)
}

/**
 * Creates the span processor that redacts the exception text of every span as it ends: the status
 * message and the `exception.message` and `exception.stacktrace` of each event. The type of the
 * exception is not touched.
 *
 * @param everyMessage - Replaces every message, not only the input a parse error quotes.
 * @returns The span processor.
 */
export function createExceptionTextRedactor(everyMessage: boolean): SpanProcessor {
  return {
    onStart: () => undefined,
    onEnding: (span): void => {
      const { code, message } = span.status
      if (typeof message === 'string' && message !== '') {
        span.setStatus({
          code,
          message: everyMessage ? REDACTED : redactParseErrorText(message)
        })
      }
      for (const { attributes } of span.events) {
        if (attributes === undefined) continue
        const recorded = attributes['exception.message']
        const stack = attributes['exception.stacktrace']
        // The stack is read against the recorded message, so it is redacted before the message is.
        if (typeof stack === 'string') {
          attributes['exception.stacktrace'] = everyMessage
            ? redactStackText(stack, recorded)
            : redactParseErrorText(stack)
        }
        if (recorded === undefined) continue
        if (everyMessage) attributes['exception.message'] = REDACTED
        else if (typeof recorded === 'string') {
          attributes['exception.message'] = redactParseErrorText(recorded)
        }
      }
    },
    onEnd: () => undefined,
    shutdown: resolvedPromise,
    forceFlush: resolvedPromise
  }
}
