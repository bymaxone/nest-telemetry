/**
 * @fileoverview Module that drains the OpenTelemetry SDK when the application shuts down.
 * @layer nest
 */
import { Global, Module } from '@nestjs/common'

import { TelemetryShutdownHook } from './telemetry-shutdown.hook'

/**
 * List it first in the imports of the application module, before any module that is global or
 * imports a global module. Nest then awaits the SDK
 * flush while closing the application, so buffered spans are exported before the process exits.
 * The SDK itself is started by the `./register` preload or by `startTelemetry`, outside Nest.
 */
@Global()
@Module({ providers: [TelemetryShutdownHook] })
export class TelemetryModule {}
