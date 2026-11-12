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
})
