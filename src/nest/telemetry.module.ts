/**
 * @fileoverview Module that drains the OpenTelemetry SDK when the application shuts down.
 * @layer nest
 */
import { Global, Module } from '@nestjs/common'

import { TelemetryShutdownHook } from './telemetry-shutdown.hook'

/**
 * Import it in the application module, before any other global module. Nest then awaits the SDK
 * flush while closing the application, so buffered spans are exported before the process exits.
 * Nest closes global modules last, and among them in the reverse of their registration order, so
 * the module registered first closes last: spans another global module ends while closing are
 * exported only when this one is registered before it. The SDK itself is started by the
 * `./register` preload or by `startTelemetry`, outside Nest.
 */
@Global()
@Module({ providers: [TelemetryShutdownHook] })
export class TelemetryModule {}
