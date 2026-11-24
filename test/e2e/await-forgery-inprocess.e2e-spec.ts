/**
 * @fileoverview Pins, in the test process, the paths of the start and of the guarded send that the real-process
 * rows cannot reach: a package list that cannot be trusted, a name on the prototype of an array or a function, an
 * SDK that cannot be built and a transport that throws before it answers.
 * @layer e2e
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

import { guardExports } from '../../src/sdk/export-guard'
import { clearHandle, clearPendingStart } from '../../src/sdk/handle'
import { startTelemetry } from '../../src/sdk/start'

let sdkFails = false

jest.mock('@opentelemetry/sdk-node', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@opentelemetry/sdk-node')
  const Real = actual['NodeSDK'] as new (...args: unknown[]) => unknown
  return {
    ...actual,
    NodeSDK: function (...args: unknown[]): unknown {
      if (sdkFails) throw new Error('sdk refused')
      return new Real(...args)
    }
  }
})

afterEach(() => {
  sdkFails = false
  clearHandle()
  clearPendingStart()
})

describe('a start whose packages or prototypes cannot be trusted', () => {
  it('answers with the disabled handle when an import did not answer with a promise of the engine', async () => {
    // Scenario: the import of a package is compiled to Promise.resolve().then(...); with Promise.resolve replaced
    // the answer is not a native promise, so there is nothing to trust a value from and no SDK is built.
    const original = Promise.resolve
    Promise.resolve = (() => ({ then: () => ({}) })) as unknown as typeof Promise.resolve
    try {
      const handle = await startTelemetry({ env: {} })
      expect(handle.enabled).toBe(false)
    } finally {
      Promise.resolve = original
    }
  })

  it.each([Array.prototype, Function.prototype] as object[])(
    'answers with the disabled handle when a then sits on %p',
    async (target) => {
      // Scenario: an array or a function resolved into a promise is read for a then, so one planted on its
      // prototype refuses the start.
      Object.defineProperty(target, 'then', { value: () => undefined, configurable: true })
      try {
        const handle = await startTelemetry({ env: {} })
        expect(handle.enabled).toBe(false)
      } finally {
        delete (target as Record<string, unknown>)['then']
      }
    }
  )

  it('rejects the start with the reason when the SDK cannot be built', async () => {
    // Scenario: the constructor of the SDK throws after the packages loaded; the start rejects with its reason.
    sdkFails = true
    await expect(startTelemetry({ env: {} })).rejects.toThrow('sdk refused')
  })
})

describe('a start whose packages fail to load', () => {
  it('rejects once, with the first reason, when two packages are missing', async () => {
    // Scenario: two peers are missing; the start rejects with the reason of the first and takes the second
    // rejection without a second settlement or an unhandled rejection.
    jest.resetModules()
    jest.doMock('@opentelemetry/sdk-trace', () => {
      throw new Error('first missing')
    })
    jest.doMock('@opentelemetry/resources', () => {
      throw new Error('second missing')
    })
    try {
      const { startTelemetry: fresh } = await import('../../src/sdk/start')
      await expect(fresh({ env: {} })).rejects.toThrow(/first missing|second missing/)
    } finally {
      jest.dontMock('@opentelemetry/sdk-trace')
      jest.dontMock('@opentelemetry/resources')
    }
  })
})

describe('a guarded send that throws', () => {
  it('reports the export as failed, with the reason of the throw', async () => {
    // Scenario: a transport whose send throws before it returns a promise is a failed attempt; the callback of
    // the export is called once with the failure and the reason.
    const exporter = new OTLPTraceExporter({ url: 'http://127.0.0.1:1/v1/traces' })
    const inner = (
      exporter as unknown as {
        _delegate: { _transport: { _transport: { send: () => unknown } } }
      }
    )._delegate._transport._transport
    inner.send = () => {
      throw new Error('send threw')
    }
    guardExports(exporter)
    const result = await new Promise<{ code: number; error?: Error }>((resolve) =>
      exporter.export([], resolve)
    )
    expect(result.code).toBe(1)
    expect(result.error?.message).toBe('send threw')
  })

  it('passes an answer that is not a promise through as the result', async () => {
    // Scenario: a transport that answers with a plain result, not a promise, is passed through unchanged.
    const exporter = new OTLPTraceExporter({ url: 'http://127.0.0.1:1/v1/traces' })
    const inner = (
      exporter as unknown as {
        _delegate: { _transport: { _transport: { send: () => unknown } } }
      }
    )._delegate._transport._transport
    inner.send = () => ({ status: 'success' })
    guardExports(exporter)
    const result = await new Promise<{ code: number }>((resolve) => exporter.export([], resolve))
    expect(result.code).toBe(0)
  })

  it('adopts the answer of a headers provider that is a thenable and not a promise', async () => {
    // Scenario: a provider answers with an object that only has a then; the guard adopts it with a promise of
    // its own and resolves with the headers it gave.
    const exporter = new OTLPTraceExporter({ url: 'http://127.0.0.1:1/v1/traces' })
    const parameters = (
      exporter as unknown as {
        _delegate: { _transport: { _transport: { _parameters: { headers: () => unknown } } } }
      }
    )._delegate._transport._transport._parameters
    parameters.headers = () => ({
      then: (resolve: (value: Record<string, string>) => void): void => resolve({ 'x-host': 'yes' })
    })
    guardExports(exporter)
    exporter.export([], () => undefined)
    await expect(parameters.headers()).resolves.toMatchObject({ 'x-host': 'yes' })
  })
})
