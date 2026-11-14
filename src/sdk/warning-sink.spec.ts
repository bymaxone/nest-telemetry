import { clearWarningSink, registerWarningSink, reportWarning } from './warning-sink'
import type { TelemetryWarning } from './warning-sink'

const warning: TelemetryWarning = {
  code: 'BYMAX_TELEMETRY_EXPORT_FAILED',
  text: 'Exporting spans failed.',
  fields: { kind: 'otlp-http traces', code: 'ECONNREFUSED' }
}

describe('reportWarning', () => {
  let emitWarning: jest.SpyInstance

  beforeEach(() => {
    emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  })

  afterEach(() => {
    clearWarningSink()
  })

  it('emits a process warning with the text and the code when no sink is registered', () => {
    // Scenario: a host that bound no logger gets the process warning, with the text and the code.
    reportWarning(warning)
    expect(emitWarning).toHaveBeenCalledTimes(1)
    expect(emitWarning).toHaveBeenCalledWith(warning.text, {
      type: 'Warning',
      code: 'BYMAX_TELEMETRY_EXPORT_FAILED'
    })
  })

  it('hands the warning to the sink and emits nothing when the sink handles it', () => {
    // Scenario: a bound logger takes the warning, so it is not also printed as a process warning.
    const sink = jest.fn(() => true)
    registerWarningSink(sink)
    reportWarning(warning)
    expect(sink).toHaveBeenCalledWith(warning)
    expect(emitWarning).not.toHaveBeenCalled()
  })

  it('falls back to the process warning when the sink declines', () => {
    // Scenario: the sink has no route for this warning, such as a logger without the method.
    registerWarningSink(() => false)
    reportWarning(warning)
    expect(emitWarning).toHaveBeenCalledTimes(1)
  })

  it('falls back to the process warning, and never throws, when the sink throws', () => {
    // Scenario: the host's logger fails. The caller is an exporter callback and a flush, and neither
    // may be disturbed by a diagnostic.
    registerWarningSink(() => {
      throw new Error('logger failed')
    })
    expect(() => reportWarning(warning)).not.toThrow()
    expect(emitWarning).toHaveBeenCalledTimes(1)
  })
})

describe('registerWarningSink', () => {
  beforeEach(() => {
    jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
  })

  afterEach(() => {
    clearWarningSink()
  })

  it('stops routing once the registration is released', () => {
    // Scenario: the module that registered the sink is gone.
    const sink = jest.fn(() => true)
    const release = registerWarningSink(sink)
    release()
    reportWarning(warning)
    expect(sink).not.toHaveBeenCalled()
  })

  it('is emptied by clearWarningSink, whichever module registered the sink', () => {
    // Scenario: a test harness drops whatever sink an earlier case left behind.
    const sink = jest.fn(() => true)
    registerWarningSink(sink)
    clearWarningSink()
    reportWarning(warning)
    expect(sink).not.toHaveBeenCalled()
  })

  it('releases only the sink it registered', () => {
    // Scenario: two module instances in one process, as in a test suite or a hot reload. The first
    // one shutting down must not remove the sink the second one registered.
    const first = jest.fn(() => true)
    const second = jest.fn(() => true)
    const releaseFirst = registerWarningSink(first)
    registerWarningSink(second)
    releaseFirst()
    reportWarning(warning)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('shares the registration through globalThis, so a second copy of the library sees it', () => {
    // Scenario: the preload and the application are separate module graphs, so the sink lives under
    // a registry symbol on globalThis and nowhere else.
    const sink = jest.fn(() => true)
    registerWarningSink(sink)
    expect(Reflect.get(globalThis, Symbol.for('@bymax-one/nest-telemetry/warning-sink'))).toBe(sink)
  })
})
