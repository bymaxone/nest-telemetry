/**
 * @fileoverview Pins that the preload boot warns and returns a disabled handle, instead of
 * stopping the host, when an optional peer cannot be loaded.
 * @layer e2e
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { bootFromEnvironment } from '../../src/register/boot'

// The SDK package cannot be loaded, as when an optional peer is not installed.
jest.mock('@opentelemetry/sdk-node', () => {
  throw new Error('Cannot find module @opentelemetry/sdk-node')
})

const PARENT = pathToFileURL(join(__dirname, 'preload.mjs')).href

describe('the preload boot when an optional peer cannot be loaded', () => {
  it('warns and returns a disabled handle instead of stopping the host', async () => {
    // Scenario: `--import` of the preload with the SDK package missing. The failure surfaces at the
    // preload boundary as a warning, so the application that follows still loads.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const handle = await bootFromEnvironment(PARENT, { env: { OTEL_SERVICE_NAME: 'preload' } })
    expect(handle.enabled).toBe(false)
    await expect(handle.shutdown()).resolves.toBeUndefined()
    expect(emitWarning).toHaveBeenCalledWith(
      expect.stringContaining('Telemetry could not be started'),
      { type: 'Warning', code: 'BYMAX_TELEMETRY_START_FAILED' }
    )
  })

  it('names a start failure whose message cannot be read by its code alone', async () => {
    // Scenario: the error a start throws is an object whose message getter throws; the warning is
    // still emitted, with the code UNKNOWN and nothing of the object.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const failure = Object.defineProperty({}, 'message', {
      get: () => {
        throw new Error('boom')
      }
    })
    const handle = await bootFromEnvironment(PARENT, {
      env: { OTEL_SDK_DISABLED: 'true' },
      start: () => Promise.reject(failure)
    })
    expect(handle.enabled).toBe(false)
    expect(emitWarning).toHaveBeenCalledWith(expect.stringContaining('(code UNKNOWN)'), {
      type: 'Warning',
      code: 'BYMAX_TELEMETRY_START_FAILED'
    })
  })

  it('names the code and the package of a start that failed for want of a peer, and nothing else', async () => {
    // Scenario: the usual cause of a failed start, a peer that is not installed; the warning names
    // the package so the reader can fix it, and not the path or the rest of the message.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const failure = Object.assign(
      new Error("Cannot find package '@opentelemetry/sdk-node' imported from /srv/app/preload.mjs"),
      { code: 'ERR_MODULE_NOT_FOUND' }
    )
    await bootFromEnvironment(PARENT, {
      env: { OTEL_SDK_DISABLED: 'true' },
      start: () => Promise.reject(failure)
    })
    expect(emitWarning).toHaveBeenCalledWith(
      'Telemetry could not be started (code ERR_MODULE_NOT_FOUND, package @opentelemetry/sdk-node), so the application continues without it.',
      { type: 'Warning', code: 'BYMAX_TELEMETRY_START_FAILED' }
    )
  })

  it.each([
    ['a thrown string', 'plain text'],
    ['an error whose message names no package', new Error('refused')]
  ])('names %s by the code UNKNOWN and echoes nothing', async (_what, thrown) => {
    // Scenario: a failure with no code and no package to name is described by library text alone.
    const emitWarning = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    await bootFromEnvironment(PARENT, {
      env: { OTEL_SDK_DISABLED: 'true' },
      start: () => Promise.reject(thrown)
    })
    expect(emitWarning).toHaveBeenCalledWith(
      'Telemetry could not be started (code UNKNOWN), so the application continues without it.',
      { type: 'Warning', code: 'BYMAX_TELEMETRY_START_FAILED' }
    )
  })
})
