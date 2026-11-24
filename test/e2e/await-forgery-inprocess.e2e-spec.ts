/**
 * @fileoverview Pins, in the test process, the paths of the start and of the guarded send that the real-process
 * rows cannot reach: a package list that cannot be trusted, a name on the prototype of an array or a function, an
 * SDK that cannot be built and a transport that throws before it answers.
 * @layer e2e
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

import { guardExports } from '../../src/sdk/export-guard'
import {
  clearHandle,
  clearPendingStart,
  createHandle,
  currentHandle,
  registerHandle,
  setPendingStart,
  shutdownTelemetry
} from '../../src/sdk/handle'
import { ownConstructor } from '../../src/sdk/native-promise'
import { startTelemetry } from '../../src/sdk/start'

let sdkFails = false
let plantOnStart = false

jest.mock('@opentelemetry/sdk-node', () => {
  const actual = jest.requireActual<Record<string, unknown>>('@opentelemetry/sdk-node')
  const Real = actual['NodeSDK'] as new (...args: unknown[]) => unknown
  return {
    ...actual,
    NodeSDK: function (...args: unknown[]): unknown {
      if (sdkFails) throw new Error('sdk refused')
      const sdk = new Real(...args) as { start: () => void }
      if (plantOnStart) {
        const start = sdk.start.bind(sdk)
        sdk.start = (): void => {
          start()
          Object.defineProperty(Object.prototype, 'zzPlantedOnStart', {
            value: 1,
            configurable: true
          })
        }
      }
      return sdk
    }
  }
})

afterEach(() => {
  sdkFails = false
  plantOnStart = false
  Reflect.deleteProperty(Object.prototype, 'zzPlantedOnStart')
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

/** A native promise of a host whose own `constructor` throws when read, as a `then` reads it for a species. */
function unconsumablePromise<T>(settle: (resolve: (value: T) => void) => void): Promise<T> {
  const promise = new Promise<T>(settle)
  Object.defineProperty(promise, 'constructor', {
    configurable: true,
    get(): never {
      throw new Error('hostile constructor')
    }
  })
  return promise
}

/** The transport of an exporter, reached the way the guard reaches it. */
function transportOf(exporter: OTLPTraceExporter): {
  send: (data: unknown, timeout: unknown) => unknown
  _parameters: Record<string, () => unknown>
} {
  return (
    exporter as unknown as {
      _delegate: {
        _transport: {
          _transport: {
            send: (data: unknown, timeout: unknown) => unknown
            _parameters: Record<string, () => unknown>
          }
        }
      }
    }
  )._delegate._transport._transport
}

describe('a start beside a promise of a host that cannot be consumed', () => {
  it('rejects a start that joins a promise of a host, whose constructor throws, with a typed error', async () => {
    // Scenario: the start in progress is a promise of another copy whose constructor throws when a then reads it; it
    // cannot be consumed, so the call fails typed like every other wait that cannot be made, and reads nothing.
    setPendingStart(unconsumablePromise<never>(() => undefined))
    await expect(startTelemetry({ env: {} })).rejects.toMatchObject({
      code: 'BYMAX_TELEMETRY_REALM_POLLUTED'
    })
  })

  it('pins the pending start before it is published, so a host accessor on the slot cannot forge the answer', async () => {
    // Scenario: a host accessor on the pending-start slot pins a constructor and a then on the promise it is handed,
    // and freezes it; the promise already holds its own read-only constructor, so the pin throws and the call does
    // not resolve the forged handle.
    const key = Symbol.for('@bymax-one/nest-telemetry/pending-start')
    const forged = Object.freeze({ forged: true, enabled: true, shutdown: () => Promise.resolve() })
    let held: unknown
    Object.defineProperty(globalThis, key, {
      configurable: true,
      get: () => held,
      set(promise: Promise<unknown>) {
        held = promise
        Object.defineProperty(promise, 'constructor', { value: Object })
        Object.defineProperty(promise, 'then', {
          value: (res: (v: unknown) => void) => res(forged)
        })
        Object.freeze(promise)
      }
    })
    try {
      const answered = await startTelemetry({ serviceName: 's', env: {} }).then(
        (handle) => (handle as unknown as { forged?: boolean }).forged === true,
        () => false
      )
      expect(answered).toBe(false)
    } finally {
      Reflect.deleteProperty(globalThis, key)
    }
    for (let waited = 0; currentHandle() === undefined && waited < 100; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    await shutdownTelemetry()
  })

  it('rejects with a typed error when the flush of a stopping handle cannot be consumed', async () => {
    // Scenario: a handle that is stopping hands out a shutdown whose own constructor throws; the wait cannot attach,
    // so the call cannot tell the flush ended and fails with a typed error instead of going on.
    registerHandle({
      enabled: true,
      stopping: true,
      shutdown: () => unconsumablePromise<void>(() => undefined)
    })
    jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    await expect(startTelemetry({ env: {} })).rejects.toMatchObject({
      code: 'BYMAX_TELEMETRY_REALM_POLLUTED'
    })
  })

  it('stops the SDK it started when the process turned polluted while it started', async () => {
    // Scenario: a name is planted by the start of the real SDK; the answer is the disabled handle, and the SDK that
    // just started and registered is stopped, so nothing is left running with no handle to stop it.
    plantOnStart = true
    const warn = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const handle = await startTelemetry({ env: {} })
    expect(handle.enabled).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('did not start'),
      expect.objectContaining({ code: 'BYMAX_TELEMETRY_REALM_POLLUTED' })
    )
    Reflect.deleteProperty(Object.prototype, 'zzPlantedOnStart')
    await shutdownTelemetry()
    clearHandle()
  })

  it('waits for the flush of a stopping handle, then answers with the handle that is left', async () => {
    // Scenario: a start that arrives while a flush runs waits for it, and answers with the handle once it is no
    // longer stopping.
    let stopping = true
    registerHandle({
      get stopping() {
        return stopping
      },
      enabled: true,
      shutdown: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            stopping = false
            resolve()
          }, 0)
        })
    })
    const handle = await startTelemetry({ env: {} })
    expect(handle.enabled).toBe(true)
  })

  it('rejects a start that waited for a flush after which no handle is left to answer with', async () => {
    // Scenario: the flush finishes and removes the handle, so a start that waited for it finds a process that was
    // shut down, and is told so.
    const first = await startTelemetry({ env: {} })
    const stopping = first.shutdown()
    const waiting = expect(startTelemetry({ env: {} })).rejects.toThrow('cannot start again')
    await stopping
    await waiting
  })

  it('refuses a start when the constructor of Promise.prototype is deleted or replaced by a function', async () => {
    // Scenario: the slot that every then reads for a species is gone, or holds another constructor: the process is
    // not the one the library loaded in, and nothing starts.
    const original = Object.getOwnPropertyDescriptor(
      Promise.prototype,
      'constructor'
    ) as PropertyDescriptor
    jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    try {
      Reflect.deleteProperty(Promise.prototype, 'constructor')
      expect((await startTelemetry({ env: {} })).enabled).toBe(false)
      Object.defineProperty(Promise.prototype, 'constructor', {
        ...original,
        value: function () {}
      })
      expect((await startTelemetry({ env: {} })).enabled).toBe(false)
    } finally {
      Object.defineProperty(Promise.prototype, 'constructor', original)
    }
  })
})

describe('a guarded send and its providers beside a promise that cannot be consumed', () => {
  it('drops a provider answer that is a promise of the host with a constructor that throws', async () => {
    // Scenario: a provider answers with a native promise whose own constructor throws; the guard cannot attach, so the
    // answer is dropped with the pollution error and nothing of it is used.
    const exporter = new OTLPTraceExporter({ url: 'http://127.0.0.1:1/v1/traces' })
    const transport = transportOf(exporter)
    transport._parameters['headers'] = () => unconsumablePromise<unknown>((resolve) => resolve({}))
    guardExports(exporter)
    exporter.export([], () => undefined)
    const answer = transport._parameters['headers']?.() as Promise<unknown>
    await expect(answer).rejects.toMatchObject({ code: 'BYMAX_TELEMETRY_REALM_POLLUTED' })
  })

  it('answers a send whose promise had an own constructor that throws, with the result it carries', async () => {
    // Scenario: the transport answers with a native promise whose own constructor throws; the guard gives it a
    // constructor of its own before it waits, so the getter is not read and the transport's result arrives.
    const exporter = new OTLPTraceExporter({ url: 'http://127.0.0.1:1/v1/traces' })
    const transport = transportOf(exporter)
    transport.send = () => unconsumablePromise<unknown>((resolve) => resolve({ status: 'success' }))
    guardExports(exporter)
    exporter.export([], () => undefined)
    const result = (await transport.send('data', 1)) as { status: string }
    expect(result.status).toBe('success')
  })

  it('refuses a result that arrives after a name was planted on the root prototype', async () => {
    // Scenario: the transport answers later, and a name was planted meanwhile; the check right before the resolve
    // turns the result into the refusal.
    const exporter = new OTLPTraceExporter({ url: 'http://127.0.0.1:1/v1/traces' })
    const transport = transportOf(exporter)
    transport.send = () =>
      new Promise((resolve) => {
        setTimeout(() => {
          Object.defineProperty(Object.prototype, 'zzPlantedLate', {
            value: 1,
            configurable: true
          })
          resolve({ status: 'success' })
        }, 0)
      })
    guardExports(exporter)
    exporter.export([], () => undefined)
    try {
      const result = (await transport.send('data', 1)) as { status: string }
      expect(result.status).toBe('failure')
    } finally {
      delete (Object.prototype as unknown as Record<string, unknown>)['zzPlantedLate']
    }
  })
})

describe('the promises the library returns on a failure', () => {
  it('rejects the shutdown of a handle whose flush fails, with the reason of the failure', async () => {
    // Scenario: the SDK fails to stop; the caller of the handle's shutdown sees the reason and nothing else.
    const handle = createHandle(() => Promise.reject(new Error('flush failed')))
    await expect(handle.shutdown()).rejects.toThrow('flush failed')
  })

  it('rejects the shutdown of a handle whose SDK throws before it answers with a promise', async () => {
    // Scenario: stopping the SDK throws at once; the caller sees that error and the handle is finished.
    const handle = createHandle(() => {
      throw new Error('stop threw')
    })
    await expect(handle.shutdown()).rejects.toThrow('stop threw')
    expect(handle.stopping).toBe(false)
  })

  it('rejects the module-level shutdown when the start in progress cannot be consumed', async () => {
    // Scenario: the pending start carries a constructor that throws; the drain cannot wait for it and fails typed.
    setPendingStart(unconsumablePromise<never>(() => undefined))
    await expect(shutdownTelemetry()).rejects.toMatchObject({
      code: 'BYMAX_TELEMETRY_REALM_POLLUTED'
    })
  })

  it('rejects the module-level shutdown when the flush of the registered handle cannot be consumed', async () => {
    // Scenario: the registered handle answers with a promise whose constructor throws; the drain fails typed.
    registerHandle({
      enabled: true,
      stopping: false,
      shutdown: () => unconsumablePromise<void>(() => undefined)
    })
    await expect(shutdownTelemetry()).rejects.toMatchObject({
      code: 'BYMAX_TELEMETRY_REALM_POLLUTED'
    })
  })

  it('rejects the module-level shutdown when the registered handle throws', async () => {
    // Scenario: a handle registered by another copy throws when asked to stop; the caller of the shutdown hears of it.
    registerHandle({
      enabled: true,
      stopping: false,
      shutdown: () => {
        throw new Error('sync failure')
      }
    })
    await expect(shutdownTelemetry()).rejects.toThrow('sync failure')
  })

  it('hands back a frozen promise as it is, without throwing', () => {
    // Scenario: a promise that cannot take an own constructor is returned unchanged.
    const frozen = Object.freeze(new Promise<void>(() => undefined))
    expect(ownConstructor(frozen)).toBe(frozen)
  })
})
