/**
 * @fileoverview Tests the warning about a `BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT` value that is
 * not understood.
 * @layer sdk
 */
import { warnAboutRedactExceptionText } from './assembly'
import { readTelemetryEnvironment } from './environment'

describe('warnAboutRedactExceptionText', () => {
  let emitWarning: jest.SpyInstance

  beforeEach(() => {
    emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  })

  const env = (value: string) =>
    readTelemetryEnvironment({ BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT: value })

  it('warns once for an unknown value that decides, without repeating it', () => {
    // Scenario: no option was given, so the typo is what leaves the messages exported.
    warnAboutRedactExceptionText(undefined, env('yes-please'))
    expect(emitWarning).toHaveBeenCalledTimes(1)
    const [text, options] = emitWarning.mock.calls[0] as [string, { code: string }]
    expect(options.code).toBe('BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT_UNKNOWN')
    expect(text).toContain('BYMAX_TELEMETRY_REDACT_EXCEPTION_TEXT')
    expect(text).not.toContain('yes-please')
  })

  it.each([
    [true, 'yes-please'],
    [false, 'yes-please'],
    [undefined, 'false'],
    [undefined, 'true']
  ])('stays silent with the option %p and the value %p', (option, value) => {
    // Scenario: an option that was given decides, and a known value is not a mistake.
    warnAboutRedactExceptionText(option, env(value))
    expect(emitWarning).not.toHaveBeenCalled()
  })
})
