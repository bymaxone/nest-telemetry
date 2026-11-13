/**
 * @fileoverview Lets an end-to-end suite that starts one SDK per case start again.
 * @layer e2e
 */
import { clearHandle } from '../../../src/sdk/handle'

/**
 * Lets the next case start telemetry again.
 *
 * The library refuses to start a second SDK in a process that shut one down, so a suite that starts
 * one SDK per case clears the library's record of the first through its internal handle module.
 * Nothing about this is public, and a consumer's tests start once, in a global setup.
 */
export function allowRestart(): void {
  clearHandle()
}
