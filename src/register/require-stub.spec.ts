describe('the CommonJS entry of ./register', () => {
  it('refuses to load and says to use node --import', async () => {
    // Scenario: a host writes `node --require @bymax-one/nest-telemetry/register`. The SDK start is
    // asynchronous, so the application would load first and nothing would be instrumented; the
    // require fails loudly instead, with the message that names the right flag.
    await expect(import('./require-stub')).rejects.toThrow(
      '@bymax-one/nest-telemetry/register is a preload for `node --import`, and cannot be required: ' +
        'starting the SDK is asynchronous, so a `--require` preload would let the application load first.'
    )
  })
})
