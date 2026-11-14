import { warnOnExportFailure } from './export-failure'
import type { ExportOutcome, ObservableExporter } from './export-failure'

const FAILED = 1
const CODE = 'BYMAX_TELEMETRY_EXPORT_FAILED'

/** An exporter double whose next result the test chooses. */
function fakeExporter(): {
  exporter: ObservableExporter
  next: ExportOutcome
  calls: number
} {
  const state = { next: { code: 0 } as ExportOutcome, calls: 0 }
  const exporter: ObservableExporter = {
    export: (_spans, done) => {
      state.calls += 1
      done(state.next)
    }
  }
  return {
    exporter,
    get next() {
      return state.next
    },
    set next(value: ExportOutcome) {
      state.next = value
    },
    get calls() {
      return state.calls
    }
  }
}

function exportOnce(exporter: ObservableExporter): ExportOutcome[] {
  const seen: ExportOutcome[] = []
  exporter.export([], (result) => seen.push(result))
  return seen
}

describe('warnOnExportFailure', () => {
  let emitWarning: jest.SpyInstance

  beforeEach(() => {
    emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  })

  it('warns once with the exporter kind and the error code when an export fails', () => {
    // Scenario: the collector is unreachable, so the batch is dropped and nobody would know.
    const double = fakeExporter()
    double.next = {
      code: FAILED,
      error: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
    }
    warnOnExportFailure(double.exporter, 'otlp-http traces')
    exportOnce(double.exporter)
    expect(emitWarning).toHaveBeenCalledTimes(1)
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('otlp-http traces'), {
      type: 'Warning',
      code: CODE
    })
    expect(emitWarning.mock.calls[0]?.[0]).toContain('ECONNREFUSED')
  })

  it('stays silent when the export succeeds', () => {
    // Scenario: the healthy path adds no warning.
    const double = fakeExporter()
    warnOnExportFailure(double.exporter, 'otlp-http traces')
    exportOnce(double.exporter)
    expect(emitWarning).not.toHaveBeenCalled()
  })

  it('hands the result to the caller unchanged, failure included', () => {
    // Scenario: the batch processor still sees the failure and does what it did before.
    const double = fakeExporter()
    const failure = { code: FAILED, error: new Error('boom') }
    double.next = failure
    warnOnExportFailure(double.exporter, 'otlp-http traces')
    expect(exportOnce(double.exporter)).toEqual([failure])
  })

  it('warns once per minute however many exports fail', () => {
    // Scenario: a collector that stays down must not turn into a warning per batch.
    let now = 1_000_000
    const double = fakeExporter()
    double.next = { code: FAILED, error: new Error('x') }
    warnOnExportFailure(double.exporter, 'otlp-http traces', () => now)
    exportOnce(double.exporter)
    now += 59_999
    exportOnce(double.exporter)
    exportOnce(double.exporter)
    expect(emitWarning).toHaveBeenCalledTimes(1)
    now += 1
    exportOnce(double.exporter)
    expect(emitWarning).toHaveBeenCalledTimes(2)
    exportOnce(double.exporter)
    expect(emitWarning).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a string code', Object.assign(new Error('m'), { code: 'ETIMEDOUT' }), 'ETIMEDOUT'],
    ['a lower-case code', Object.assign(new Error('m'), { code: 'etimedout' }), 'UNKNOWN'],
    ['a numeric status', Object.assign(new Error('m'), { code: 503 }), '503'],
    [
      'a code that is not a plain token',
      Object.assign(new Error('m'), { code: 'http://secret.example/?k=1' }),
      'UNKNOWN'
    ],
    ['no code', new Error('m'), 'UNKNOWN'],
    ['no error', undefined, 'UNKNOWN']
  ])('names the failure by %s and never by its message or payload', (_what, error, expected) => {
    // Scenario: the warning is value-free; only a short code token reaches it, never the message,
    // which can carry an endpoint, a header or a payload fragment.
    const double = fakeExporter()
    double.next = error === undefined ? { code: FAILED } : { code: FAILED, error }
    warnOnExportFailure(double.exporter, 'otlp-http traces')
    exportOnce(double.exporter)
    const text = String(emitWarning.mock.calls[0]?.[0])
    expect(text).toContain(`code ${expected}`)
    expect(text).not.toContain('secret.example')
  })

  it('returns the exporter it was given, so the batch processor receives the same object', () => {
    // Scenario: the wrapper is not a second exporter with its own shutdown.
    const double = fakeExporter()
    expect(warnOnExportFailure(double.exporter, 'otlp-http traces')).toBe(double.exporter)
  })

  it('warns once over a hundred failed exports inside the window, and again after it', () => {
    // Scenario: a collector that stays down fails every export interval; a hundred failures in
    // under a minute are one warning, never one per batch.
    let now = 0
    const double = fakeExporter()
    double.next = { code: FAILED, error: new Error('x') }
    warnOnExportFailure(double.exporter, 'otlp-http traces', () => now)
    for (let index = 0; index < 100; index += 1) {
      now = index * 500
      exportOnce(double.exporter)
    }
    expect(emitWarning).toHaveBeenCalledTimes(1)
    now = 60_000
    exportOnce(double.exporter)
    expect(emitWarning).toHaveBeenCalledTimes(2)
  })

  it('still hands the unchanged result back when the warning itself throws', () => {
    // Scenario: a diagnostic must never alter or lose the export outcome the SDK accounts for, so a
    // throwing warning path neither throws out of the callback nor swallows the failure.
    emitWarning.mockImplementation(() => {
      throw new Error('warning path broke')
    })
    const double = fakeExporter()
    const failure = { code: FAILED, error: new Error('x') }
    double.next = failure
    warnOnExportFailure(double.exporter, 'otlp-http traces')
    const seen = exportOnce(double.exporter)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(failure)
  })
})
