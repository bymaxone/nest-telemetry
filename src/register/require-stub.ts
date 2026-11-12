/**
 * @fileoverview The CommonJS face of `./register`, which only explains why it cannot work.
 * @layer register
 */
export {}

// Throws when loaded, so requiring the preload is loud: starting the SDK is asynchronous, and a
// `--require` preload cannot wait for it, which would let the application load first, unnoticed.
throw new Error(
  '@bymax-one/nest-telemetry/register is a preload for `node --import`, and cannot be required: ' +
    'starting the SDK is asynchronous, so a `--require` preload would let the application load first.'
)
