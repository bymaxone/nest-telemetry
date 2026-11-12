/**
 * @fileoverview What a unit spec gets when it asks for `supertest`: an error that says what to do.
 * @layer scripts
 *
 * Jest turns an error thrown by a resolver into "Cannot find module", which says nothing of the
 * reason. The resolver hands this file back instead, and loading it fails with the reason.
 */
throw new Error(
  'A unit spec opens no socket, so it cannot load supertest. Use request and response doubles, ' +
    'or move the case to test/e2e.'
)
