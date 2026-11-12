import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ignorePaths } from '@bymax-one/nest-telemetry'

/** Sends a request to a server that answers with the predicate's verdict on the request it saw. */
async function verdictFor(
  predicate: (request: { url?: string | undefined }) => boolean,
  target: string
): Promise<boolean> {
  const server = createServer((incoming, response) => {
    response.end(String(predicate(incoming)))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    return await new Promise<boolean>((resolve, reject) => {
      const outgoing = request({ host: '127.0.0.1', port, path: target }, (response) => {
        let body = ''
        response.on('data', (chunk: Buffer) => {
          body += chunk.toString('utf8')
        })
        response.on('end', () => resolve(body === 'true'))
      })
      outgoing.on('error', reject)
      outgoing.end()
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

describe('ignorePaths on real incoming requests', () => {
  const probe = ignorePaths([/^\/health\/(live|ready)\/?$/, /^\/metrics\/?$/])

  it.each([
    ['/health/live', true],
    ['/health/ready/', true],
    ['/metrics?format=prometheus', true],
    ['/orders?next=/health/live', false],
    ['/api/metrics-report', false]
  ])('answers %s with %p', async (target, expected) => {
    // Scenario: a real request object, as the HTTP instrumentation hands it over, is judged on
    // its path alone.
    await expect(verdictFor(probe, target)).resolves.toBe(expected)
  })

  it('does not match a request that carries no target', () => {
    // Scenario: a missing url fails open, so the request is traced.
    expect(probe({})).toBe(false)
  })

  it('answers the same on every call for a pattern with the global flag', async () => {
    // Scenario: a /g pattern keeps lastIndex between tests; the predicate must not inherit it.
    const sticky = ignorePaths([/^\/health$/g])
    const answers = [
      await verdictFor(sticky, '/health'),
      await verdictFor(sticky, '/health'),
      await verdictFor(sticky, '/health')
    ]
    expect(answers).toEqual([true, true, true])
  })
})
