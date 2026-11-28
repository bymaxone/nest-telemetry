/**
 * @fileoverview Pins the redaction of exception text through the real SDK: the input V8 quotes in a
 * `JSON.parse` message never reaches the exporter, and `redactExceptionText` removes every message.
 * @layer e2e
 */
import { context, propagation, SpanStatusCode, trace } from '@opentelemetry/api'
import type { Span } from '@opentelemetry/api'

import { shutdownTelemetry, startTelemetry } from '@bymax-one/nest-telemetry'
import type { TelemetryOptions } from '@bymax-one/nest-telemetry'

import { startCollector } from './fixtures/collector'
import type { Collector } from './fixtures/collector'
import { allowRestart } from './fixtures/restart'

/** The letters secrets are built from: nothing else exported here is written with them. */
const LETTERS = 'Ωψχφυτσρπξνμλκθηζ'
/** A planted secret. */
const SECRET = 'ΩψχφυτσρπξνμλκθηζΩψχ'

let collector: Collector

beforeEach(async () => {
  jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  collector = await startCollector()
  process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = collector.endpoint
})

afterEach(async () => {
  await shutdownTelemetry()
  trace.disable()
  context.disable()
  propagation.disable()
  allowRestart()
  delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
  await collector.close()
})

/** The error `JSON.parse` throws for an input, or `undefined` when the input parses. */
function parseError(input: string): Error | undefined {
  try {
    JSON.parse(input)
    return undefined
  } catch (error) {
    return error as Error
  }
}

/** Records an error on a span of its own, the way an instrumentation does. */
function record(name: string, error: Error): void {
  const span = trace.getTracer('e2e').startSpan(name)
  span.recordException(error)
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
  span.end()
}

/** One exported span, as much of it as these tests read. */
interface ExportedSpan {
  readonly name: string
  readonly status: { readonly message?: string }
  readonly events: readonly {
    readonly attributes: readonly { key: string; value: { stringValue?: string } }[]
  }[]
}

/** Starts the SDK, records the errors, flushes, and returns the exported spans by name. */
async function exported(
  options: TelemetryOptions,
  errors: Readonly<Record<string, Error>>
): Promise<Map<string, { status: string | undefined; event: Record<string, string> }>> {
  const started = await startTelemetry({ env: {}, ...options })
  for (const [name, error] of Object.entries(errors)) record(name, error)
  await started.shutdown()
  const spans = new Map<string, { status: string | undefined; event: Record<string, string> }>()
  for (const body of collector.bodies) {
    const parsed = JSON.parse(body) as {
      resourceSpans: { scopeSpans: { spans: ExportedSpan[] }[] }[]
    }
    for (const resource of parsed.resourceSpans) {
      for (const scope of resource.scopeSpans) {
        for (const span of scope.spans) {
          const event: Record<string, string> = {}
          for (const attribute of span.events[0]?.attributes ?? []) {
            event[attribute.key] = attribute.value.stringValue ?? ''
          }
          spans.set(span.name, { status: span.status.message, event })
        }
      }
    }
  }
  return spans
}

/** Every character of {@link LETTERS} found in the exported bodies. */
function leaked(): string[] {
  const body = collector.bodies.join('\n')
  return [...LETTERS].filter((letter) => body.includes(letter))
}

/** One input per message shape in which V8 quotes the input, with the pattern that shape matches. */
const SHAPES: readonly [string, string, RegExp][] = [
  ['the whole input', `password=${SECRET.slice(0, 6)}`, /^Unexpected token 'p', "[^.]/],
  ['a head, cut', `x${SECRET}${SECRET}`, /^Unexpected token 'x', "x.*"\.\.\. is not/],
  [
    'a middle, cut at both ends',
    `{"password":${SECRET}${SECRET}}`,
    /^Unexpected token '.', \.\.\.".*"\.\.\. is not/
  ],
  [
    'a tail, cut',
    `{"aaaaaaaaaaaaaaaaaaaa":"b","p":${SECRET.slice(0, 5)}}`,
    /^Unexpected token '.', \.\.\.".*[^.]" is not/
  ],
  ['a quote as the token', `['${SECRET.slice(0, 5)}']`, /^Unexpected token ''', /],
  ['newlines and quotes inside', `x\n"${SECRET.slice(0, 4)}\n" is not valid JSON`, /\n/]
]

describe('parse-error text through the real SDK', () => {
  it.each(SHAPES)(
    'exports none of the input when V8 quotes %s, and keeps the type and frames',
    async (_what, input, shape) => {
      // Scenario: a malformed body carrying a secret fails to parse, and the instrumentation records
      // the error as the status message and an exception event. No letter of the secret may leave.
      const error = parseError(input) as Error
      expect(error.message).toMatch(shape)

      const spans = await exported({}, { parse: error })

      expect(leaked()).toEqual([])
      const span = spans.get('parse')
      expect(span?.status).toBe('[redacted] is not valid JSON')
      expect(span?.event['exception.type']).toBe('SyntaxError')
      expect(span?.event['exception.message']).toBe('[redacted] is not valid JSON')
      expect(span?.event['exception.stacktrace']).toMatch(
        /^SyntaxError: \[redacted\] is not valid JSON\n {4}at JSON\.parse /
      )
    }
  )

  it('exports none of a random secret from random malformed JSON', async () => {
    // Scenario: shapes nobody listed. Several hundred seeded inputs put a random secret between
    // random JSON fragments; whatever message V8 writes for each, no letter of any secret leaves.
    let seed = 20261127
    const pick = (below: number): number => (seed = (seed * 48271) % 2147483647) % below
    const junk = [
      '{',
      '}',
      '[',
      ']',
      '"',
      ':',
      ',',
      ' ',
      '\n',
      '\\',
      'a',
      '1',
      '-',
      '.',
      "'",
      '...'
    ]
    const noise = (length: number): string =>
      Array.from({ length }, () => junk[pick(junk.length)]).join('')
    const errors: Record<string, Error> = {}
    while (Object.keys(errors).length < 500) {
      const secret = Array.from({ length: 1 + pick(30) }, () => LETTERS[pick(LETTERS.length)])
      const error = parseError(`${noise(pick(30))}${secret.join('')}${noise(pick(30))}`)
      if (error !== undefined) errors[`fuzz-${Object.keys(errors).length}`] = error
    }
    const quoting = Object.values(errors).filter((error) => /[Ω-ψ]/.test(error.message))
    expect(quoting.length).toBeGreaterThan(100)

    const spans = await exported({}, errors)

    expect(spans.size).toBe(500)
    expect(leaked()).toEqual([])
  })

  it('drops the quoted part of a parse-error shape it does not know', async () => {
    // Scenario: a later engine words the message differently. The class is still recognizable by its
    // ending, so everything before it is dropped rather than kept.
    const error = new SyntaxError(`Bad character near \`${SECRET}\` which is not valid JSON`)

    const spans = await exported({}, { unknown: error })

    expect(leaked()).toEqual([])
    expect(spans.get('unknown')?.status).toBe('[redacted] is not valid JSON')
  })

  it('drops the quoted part of a message that was cut before its ending', async () => {
    // Scenario: a host shortens the message of the parse error before it rethrows, so the ending
    // that marks the class is gone and the quoted input is still there.
    const error = new Error(`Unexpected token 'p', "password=${SECRET}`)

    const spans = await exported({}, { cut: error })

    expect(leaked()).toEqual([])
    expect(spans.get('cut')?.status).toBe('[redacted]')
  })

  it('leaves other exception text as recorded without redactExceptionText', async () => {
    // Scenario: the default covers parse errors only; any other message is the host's to keep.
    const error = new Error(`duplicate key ${SECRET}`)

    const spans = await exported({}, { driver: error })

    expect(spans.get('driver')?.status).toBe(`duplicate key ${SECRET}`)
    expect(spans.get('driver')?.event['exception.message']).toBe(`duplicate key ${SECRET}`)
  })

  it('covers parse errors with URL redaction opted out', async () => {
    // Scenario: the URL opt-out is about URLs; it must not switch this protection off.
    const error = parseError(`password=${SECRET}`) as Error

    await exported({ unsafe: { disableUrlRedaction: true } }, { parse: error })

    expect(leaked()).toEqual([])
  })

  it('replaces every message with redactExceptionText, keeping the type and frames', async () => {
    // Scenario: the five canaries of the report (a body parser, a handler, a database driver, a
    // host call and a controller) are all gone, and each span still says what was thrown and where.
    class DatabaseError extends Error {
      override name = 'error'
    }
    const mimic = new Error(`bad\n    at ${SECRET}:1:1`)
    const reworded = new Error(`first ${SECRET}\nsecond ${SECRET}`)
    void reworded.stack
    reworded.message = 'changed'
    const errors = {
      body: parseError(`password=${SECRET}`) as Error,
      handler: new TypeError(`cannot use ${SECRET}`),
      driver: new DatabaseError(`invalid input syntax for type integer: "${SECRET}"`),
      manual: new Error(`host saw\n${SECRET}\nhere`),
      mimic
    }

    const spans = await exported({ redactExceptionText: true }, { ...errors, reworded })

    expect(leaked()).toEqual([])
    for (const name of Object.keys(errors)) {
      const span = spans.get(name)
      expect(span?.status).toBe('[redacted]')
      expect(span?.event['exception.message']).toBe('[redacted]')
      expect(span?.event['exception.stacktrace']).toMatch(/\[redacted\]\n {4}at /)
    }
    expect(spans.get('handler')?.event['exception.type']).toBe('TypeError')
    expect(spans.get('handler')?.event['exception.stacktrace']).toMatch(/^TypeError: \[redacted\]/)
    expect(spans.get('driver')?.event['exception.stacktrace']).toMatch(/^error: \[redacted\]/)
  })

  it('keeps every frame when the message is a word the frames hold too', async () => {
    // Scenario: "node" is in the path of the frames, which are not the message.
    const error = new Error('node')
    const frames = (error.stack as string).slice('Error: node'.length)
    expect(frames).toContain('node')

    const spans = await exported({ redactExceptionText: true }, { word: error })

    expect(spans.get('word')?.event['exception.stacktrace']).toBe(`Error: [redacted]${frames}`)
  })

  it.each([
    ['with the default', false],
    ['with redactExceptionText', true]
  ])('takes events that hold no exception text %s', async (_what, redactExceptionText) => {
    // Scenario: spans carry events with no attributes, with other attributes, with a recorded
    // string (no stack), with an error that has no message (no message attribute) and with a
    // message that is not a string. Each is exported, and nothing but the message changes.
    const started = await startTelemetry({ env: {}, redactExceptionText })
    const tracer = trace.getTracer('e2e')
    const bare = tracer.startSpan('bare')
    bare.addEvent('nothing')
    bare.addEvent('other', { kept: 'kept-value' })
    bare.setStatus({ code: SpanStatusCode.ERROR })
    bare.end()
    const text = tracer.startSpan('text')
    text.recordException('plain words')
    text.end()
    const silent = tracer.startSpan('silent')
    silent.recordException(new TypeError(''))
    silent.end()
    const numeric = tracer.startSpan('numeric')
    numeric.addEvent('exception', { 'exception.message': 7 })
    numeric.end()
    await started.shutdown()

    const body = collector.bodies.join('\n')
    expect(body).toContain('kept-value')
    expect(body).toContain('"nothing"')
    expect(body.includes('plain words')).toBe(!redactExceptionText)
    expect(body).toContain(redactExceptionText ? 'TypeError: [redacted]\\n    at ' : 'TypeError')
    // The closing brace keeps a number that only starts with 7, such as the process id, out.
    expect(body.includes('"intValue":7}')).toBe(!redactExceptionText)
  })
})

describe('values and failures the SDK lets through', () => {
  it.each([
    ['with the default', false],
    ['with redactExceptionText', true]
  ])('exports no input from arrays %s', async (_what, redactExceptionText) => {
    // Scenario: an event added by hand carries arrays of text where the SDK writes strings.
    const quoted = parseError(`password=${SECRET.slice(0, 6)}`)?.message ?? ''
    const started = await startTelemetry({ env: {}, redactExceptionText })
    const span = trace.getTracer('e2e').startSpan('arrays')
    span.addEvent('exception', {
      'exception.message': [quoted, null],
      'exception.stacktrace': [`SyntaxError: ${quoted}`]
    })
    span.end()
    await started.shutdown()

    expect(collector.bodies.join('\n')).toContain('[redacted]')
    expect(leaked()).toEqual([])
  })

  it('keeps no line of a message cut by the length limit with redactExceptionText', async () => {
    // Scenario: the SDK cuts message and stack apart, right after a line written like a frame.
    const imitation = `x\n    at ${SECRET}:1:2`
    process.env['OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT'] = String(`Error: ${imitation}`.length)
    try {
      const started = await startTelemetry({ env: {}, redactExceptionText: true })
      record('cut', new Error(`${imitation}\nand the rest of the message`))
      await started.shutdown()
    } finally {
      delete process.env['OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT']
    }

    expect(collector.bodies.join('\n')).toContain('"Error: [redacted]"')
    expect(leaked()).toEqual([])
  })

  it('keeps no frame of a very long stack with redactExceptionText', async () => {
    // Scenario: searching a very long stack for its message could stall the host.
    const started = await startTelemetry({ env: {}, redactExceptionText: true })
    record('long', new Error(SECRET.repeat(2_000)))
    await started.shutdown()

    const body = collector.bodies.join('\n')
    expect(body).toContain('"Error: [redacted]"')
    expect(leaked()).toEqual([])
  })

  it('ends the span and exports no exception text when the redaction throws', async () => {
    // Scenario: an attribute throws when read; end() must return and nothing unredacted may leave.
    const started = await startTelemetry({ env: {} })
    const span = trace.getTracer('e2e').startSpan('failing')
    span.addEvent('exception', { 'exception.message': SECRET })
    span.setStatus({ code: SpanStatusCode.ERROR, message: 'plain words' })
    const [event] = (span as unknown as { events: { attributes: object }[] }).events
    Object.defineProperty(event?.attributes, 'exception.stacktrace', {
      enumerable: true,
      get: () => {
        throw new Error('unreadable')
      }
    })

    expect(() => span.end()).not.toThrow()
    await started.shutdown()

    const body = collector.bodies.join('\n')
    expect(body).toContain('failing')
    expect(body).not.toContain('exception.message')
    expect(body).not.toContain('plain words')
    expect(body).toContain('"message":"[redacted]"')
    expect(leaked()).toEqual([])
  })

  it('adds no status message to a span with no status when the redaction throws', async () => {
    // Scenario: the span never failed, so the export gains no status message, only loses the event.
    const started = await startTelemetry({ env: {} })
    const span = trace.getTracer('e2e').startSpan('unfailed')
    span.addEvent('exception', { 'exception.message': SECRET })
    const [event] = (span as unknown as { events: { attributes: object }[] }).events
    Object.defineProperty(event?.attributes, 'exception.stacktrace', {
      enumerable: true,
      get: () => {
        throw new Error('unreadable')
      }
    })

    span.end()
    await started.shutdown()

    const body = collector.bodies.join('\n')
    expect(body).toContain('unfailed')
    expect(body).not.toContain('[redacted]')
    expect(leaked()).toEqual([])
  })

  it('exports the redacted text of a span whose setStatus ignores the call', async () => {
    // Scenario: something wrapped setStatus after the status was set.
    const started = await startTelemetry({ env: {}, redactExceptionText: true })
    const span = trace.getTracer('e2e').startSpan('wrapped')
    span.setStatus({ code: SpanStatusCode.ERROR, message: SECRET })
    span.setStatus = (): Span => span

    span.end()
    await started.shutdown()

    expect(collector.bodies.join('\n')).toContain('"message":"[redacted]"')
    expect(leaked()).toEqual([])
  })
})

describe('BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT', () => {
  const NAME = 'BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT'
  const CODE = 'BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT_UNKNOWN'

  /** The warnings with the code of an unknown value, as the text of each. */
  const unknownWarnings = (): string[] =>
    jest
      .mocked(process.emitWarning)
      .mock.calls.filter((call) => (call[1] as { code?: string } | undefined)?.code === CODE)
      .map((call) => String(call[0]))

  it.each(['true', '1'])('replaces every message when it is %p', async (value) => {
    // Scenario: an application on the preload has no options object, so the variable turns it on.
    const error = new Error(`duplicate key ${SECRET}`)

    const spans = await exported({ env: { [NAME]: value } }, { driver: error })

    expect(leaked()).toEqual([])
    expect(spans.get('driver')?.status).toBe('[redacted]')
    expect(unknownWarnings()).toEqual([])
  })

  it('stays off and warns, without the value, for a value it does not know', async () => {
    // Scenario: a typo must not be taken for off in silence, and the value is not repeated.
    const error = new Error('duplicate key')

    const spans = await exported({ env: { [NAME]: 'yes-please' } }, { driver: error })

    expect(spans.get('driver')?.status).toBe('duplicate key')
    expect(unknownWarnings()).toHaveLength(1)
    expect(unknownWarnings()[0]).not.toContain('yes-please')
  })

  it.each([
    [false, 'true', 'duplicate key'],
    [true, 'false', '[redacted]'],
    [true, 'yes-please', '[redacted]']
  ])('lets the option %p win over the variable %p', async (redactExceptionText, value, status) => {
    // Scenario: the host's own code decides when both are given, and nothing is said of a
    // variable that has no effect.
    const error = new Error('duplicate key')

    const spans = await exported({ redactExceptionText, env: { [NAME]: value } }, { driver: error })

    expect(spans.get('driver')?.status).toBe(status)
    expect(unknownWarnings()).toEqual([])
  })
})
