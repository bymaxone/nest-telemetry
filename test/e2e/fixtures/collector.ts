import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** A local OTLP/HTTP receiver that keeps every request body it is sent. */
export interface Collector {
  /** `http://127.0.0.1:<port>`, the value for `OTEL_EXPORTER_OTLP_ENDPOINT`. */
  readonly endpoint: string
  /** Every body received, in order, whatever the path. */
  readonly bodies: string[]
  /** Resolves with the bodies once at least `count` have arrived, or rejects after `timeoutMs`. */
  waitForBodies(count: number, timeoutMs: number): Promise<string[]>
  /** Stops listening. */
  close(): Promise<void>
}

/**
 * Starts a receiver on an ephemeral loopback port.
 *
 * @returns The running receiver.
 */
export async function startCollector(): Promise<Collector> {
  const bodies: string[] = []
  const server: Server = createServer((request, response) => {
    let data = ''
    request.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8')
    })
    request.on('end', () => {
      bodies.push(data)
      response.setHeader('content-type', 'application/json')
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bodies,
    waitForBodies: async (count, timeoutMs) => {
      const deadline = Date.now() + timeoutMs
      while (bodies.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`expected ${count} bodies within ${timeoutMs}ms, got ${bodies.length}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return bodies
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** The span attributes found in an exported OTLP/JSON body, flattened to `name -> value`. */
export function spanAttributes(body: string, spanName: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as {
    resourceSpans?: {
      scopeSpans?: {
        spans?: { name: string; attributes?: { key: string; value: Record<string, unknown> }[] }[]
      }[]
    }[]
  }
  const attributes: Record<string, unknown> = {}
  for (const resource of parsed.resourceSpans ?? []) {
    for (const scope of resource.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        if (span.name !== spanName) continue
        for (const attribute of span.attributes ?? []) {
          attributes[attribute.key] = Object.values(attribute.value)[0]
        }
      }
    }
  }
  return attributes
}

/** The resource attributes of an exported OTLP/JSON body, flattened to `name -> value`. */
export function resourceAttributes(body: string): Record<string, unknown> {
  const parsed = JSON.parse(body) as {
    resourceSpans?: {
      resource?: { attributes?: { key: string; value: Record<string, unknown> }[] }
    }[]
  }
  const attributes: Record<string, unknown> = {}
  for (const resource of parsed.resourceSpans ?? []) {
    for (const attribute of resource.resource?.attributes ?? []) {
      attributes[attribute.key] = Object.values(attribute.value)[0]
    }
  }
  return attributes
}

/** The part of a tracer provider this suite needs: a flush that does not stop the SDK. */
interface FlushableProvider {
  forceFlush(): Promise<void>
}

/** Whether a value is a tracer provider that can be flushed. */
function isFlushable(value: unknown): value is FlushableProvider {
  return typeof value === 'object' && value !== null && 'forceFlush' in value
}

/**
 * Flushes the tracer provider the SDK registered globally, delivering every queued span.
 *
 * @param provider - The global tracer provider, or the delegate behind its proxy.
 */
export async function forceFlush(provider: unknown): Promise<void> {
  const delegate =
    typeof provider === 'object' && provider !== null && 'getDelegate' in provider
      ? (provider as { getDelegate(): unknown }).getDelegate()
      : provider
  if (isFlushable(delegate)) await delegate.forceFlush()
}
