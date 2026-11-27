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
  const token = text.indexOf(TOKEN_START)
  // The token is one character, two UTF-16 units at most, so its end is found right after it.
  const after = token + TOKEN_START.length
  const named = token >= 0 && text.slice(after + 1, after + 5).includes(TOKEN_END)
  const parts = text.split(PARSE_ERROR_END)
  if (parts.length === 1) return named ? `${classHead(text)}${REDACTED}` : text
  const rest = parts[parts.length - 1] as string
  const kept = named ? leadingFrames(rest) : rest
  return `${classHead(text)}${REDACTED} ${PARSE_ERROR_END}${kept}`
}

/** The unbroken run of frame lines that starts on the line after the first one, or nothing. */
function leadingFrames(text: string): string {
  const lines = text.split('\n')
  let frames = ''
  for (let at = 1; lines[0] === '' && at < lines.length && isFrame(lines[at] as string); at += 1) {
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
 * file named like the message, is the frame's own text.
 *
 * @param stack - The recorded stack.
 * @param message - The recorded message, when it is a string.
 * @returns The class name of the stack, when it has one, `[redacted]`, and the frames.
 */
export function redactStackText(stack: string, message: unknown): string {
  let rest = stack
  if (typeof message === 'string' && message !== '') {
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
