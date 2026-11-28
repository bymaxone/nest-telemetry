/**
 * @fileoverview Tests the count of names that make this realm's Object.prototype differ from a fresh realm's.
 * @layer sdk
 */
import { runInNewContext } from 'node:vm'

import { GUARDED_BUILTINS, pollutedNames, readBuiltins } from './prototype-guard'
import { buildRedactedQueryParams } from './redaction'

/** Runs `run` with a descriptor put on the root prototype, and removes or restores it after. */
function plant(name: string, descriptor: PropertyDescriptor, run: () => void): void {
  const before = Object.getOwnPropertyDescriptor(Object.prototype, name)
  Object.defineProperty(Object.prototype, name, { configurable: true, ...descriptor })
  try {
    run()
  } finally {
    if (before === undefined) delete (Object.prototype as unknown as Record<string, unknown>)[name]
    else Object.defineProperty(Object.prototype, name, before)
  }
}

describe('pollutedNames', () => {
  it('counts nothing for a clean realm', () => {
    // Scenario: a realm nobody touched holds exactly the names a fresh one holds.
    expect(pollutedNames()).toBe(0)
  })

  it.each([
    [
      'an enumerable data name, as a JSON pollution plants it',
      { value: 1, enumerable: true, writable: true }
    ],
    ['a name that is not enumerable', { value: 1, writable: true }],
    ['an accessor', { get: (): 1 => 1 }],
    ['a read-only name', { value: 1 }]
  ])('counts a planted name: %s', (_label, descriptor) => {
    // Scenario: any string name the engine does not define counts once, whatever its flags.
    plant('plantedForTheTest', descriptor, () => {
      expect(pollutedNames()).toBe(1)
    })
    expect(pollutedNames()).toBe(0)
  })

  it.each([
    ['a setter that swallows the assignment', { set: (): void => undefined }],
    ['a getter', { get: (): number => 1 }],
    ['a read-only value', { value: 1, writable: false }]
  ])(
    'counts the name, and does not throw, when an array index is planted as %s',
    (_label, descriptor) => {
      // Scenario: an index on the root prototype is inherited by an array, so an entry appended by assignment would
      // run a setter, be dropped or throw; the guard keeps its names on an object with no prototype, so the
      // planted index counts once, as any other name, whatever it is.
      for (const index of ['0', '1']) {
        plant(index, descriptor, () => {
          expect(pollutedNames()).toBe(1)
        })
      }
      plant('0', descriptor, () => {
        plant('1', descriptor, () => {
          expect(pollutedNames()).toBe(2)
        })
      })
      expect(pollutedNames()).toBe(0)
    }
  )

  it.each([
    ['enumerable', { value: 1, enumerable: true, writable: true }],
    ['hidden', { value: 1, writable: true }]
  ])(
    'counts a planted name that is called undefined once, whether it is %s',
    (_label, descriptor) => {
      // Scenario: a loop that runs one step past its names reads the name undefined, which a descriptor map that
      // owns a key spelled 'undefined' answers: the count would be two; it is one.
      plant('undefined', descriptor, () => {
        expect(pollutedNames()).toBe(1)
      })
      expect(pollutedNames()).toBe(0)
    }
  )

  it('counts a planted enumerable symbol key, and not one that was hidden with defineProperty', () => {
    // Scenario: a symbol planted through a polluted path is enumerable, as a string name is; a symbol that
    // is not enumerable needs code that already runs in the process, and a test runner adds one.
    const key = Symbol('planted')
    Object.defineProperty(Object.prototype, key, { value: 1, enumerable: true, configurable: true })
    try {
      expect(pollutedNames()).toBe(1)
    } finally {
      delete (Object.prototype as unknown as Record<symbol, unknown>)[key]
    }
    Object.defineProperty(Object.prototype, key, { value: 1, configurable: true })
    try {
      expect(pollutedNames()).toBe(0)
    } finally {
      delete (Object.prototype as unknown as Record<symbol, unknown>)[key]
    }
  })

  it.each(['hasOwnProperty', 'toString', 'constructor', 'valueOf', 'isPrototypeOf'])(
    'counts a standard name overwritten with another value: %s',
    (name) => {
      // Scenario: a name the engine does define, swapped for something else, is not the engine's any more.
      plant(name, { value: 1, writable: true }, () => {
        expect(pollutedNames()).toBe(1)
      })
      expect(pollutedNames()).toBe(0)
    }
  )

  it('counts a standard function swapped for another function, and one made enumerable', () => {
    // Scenario: a function that is not the engine's is a change, and so is a flag that differs from the engine's.
    plant('toString', { value: () => 'x', writable: true }, () => {
      expect(pollutedNames()).toBe(1)
    })
    plant('valueOf', { value: Object.prototype.valueOf, writable: true, enumerable: true }, () => {
      expect(pollutedNames()).toBe(1)
    })
  })

  it('counts a standard name that is gone', () => {
    // Scenario: a name the fresh realm holds and this one lacks is a difference too.
    const before = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'isPrototypeOf'
    ) as PropertyDescriptor
    delete (Object.prototype as unknown as Record<string, unknown>)['isPrototypeOf']
    try {
      expect(pollutedNames()).toBe(1)
    } finally {
      Object.defineProperty(Object.prototype, 'isPrototypeOf', before)
    }
  })

  it('never runs a getter planted under the name of a descriptor field', () => {
    // Scenario: descriptors inherit from the prototype under test; an accessor called get, set or value
    // planted there must not run while the realm is compared.
    let ran = 0
    for (const name of ['get', 'set', 'value']) {
      Object.defineProperty(Object.prototype, name, {
        configurable: true,
        get: () => {
          ran += 1
          return undefined
        }
      })
    }
    // Defining the later names already read the earlier ones, as every descriptor does; only the comparison counts.
    ran = 0
    try {
      expect(pollutedNames()).toBe(3)
      expect(ran).toBe(0)
    } finally {
      for (const name of ['get', 'set', 'value']) {
        delete (Object.prototype as unknown as Record<string, unknown>)[name]
      }
    }
  })
})

type GuardModule = typeof import('./prototype-guard')

/** A copy of the module, loaded when this is called, so the test that asks for it is the one that reads its table. */
async function loadGuard(): Promise<GuardModule> {
  let loaded: GuardModule | undefined
  await jest.isolateModulesAsync(async () => {
    loaded = await import('./prototype-guard')
  })
  return loaded as GuardModule
}

/** One row per guarded member: the expression of its object, and its name. */
const MEMBERS: (readonly [number, string, string | symbol])[] = GUARDED_BUILTINS.flatMap(
  ([expression, names], at) =>
    names.map((name): readonly [number, string, string | symbol] => [at, expression, name])
)

/** The members that decision paths reach by iterating, with the object that holds each. */
const ITERATION: (readonly [string, object, string | symbol])[] = [
  ['the next of an array iterator', Object.getPrototypeOf([][Symbol.iterator]()) as object, 'next'],
  ['the iterator of an array', Array.prototype, Symbol.iterator],
  [
    'the next of a set iterator',
    Object.getPrototypeOf(new Set()[Symbol.iterator]()) as object,
    'next'
  ],
  ['the iterator of a set', Set.prototype, Symbol.iterator],
  ['the add of a set, which new Set(list) calls', Set.prototype, 'add']
]

/** Runs `run` with a member of a guarded built-in redefined as `descriptor`, then puts the original back. */
function replacing(
  row: number,
  name: string | symbol,
  descriptor: PropertyDescriptor,
  run: () => void
): void {
  const target = readBuiltins()[row] as object
  const original = Object.getOwnPropertyDescriptor(target, name) as PropertyDescriptor
  Object.defineProperty(target, name, descriptor)
  try {
    run()
  } finally {
    Object.defineProperty(target, name, original)
  }
}

describe('the built-ins that the SDK calls on a decision path', () => {
  it('counts nothing when none of them was replaced', () => {
    // Scenario: a clean process is never refused because of the wider comparison.
    expect(pollutedNames()).toBe(0)
  })

  it.each(MEMBERS)(
    'counts row %s %s.%s once it is replaced by another function',
    (row, _expression, name) => {
      // Scenario: code that ran after the library loaded assigned its own function over a member the SDK calls;
      // the realm is no longer one telemetry can trust, so the count is not zero.
      let counted = 0
      replacing(
        row,
        name,
        { value: function replaced(): void {}, writable: true, configurable: true },
        () => {
          counted = pollutedNames()
        }
      )
      expect(counted).toBeGreaterThan(0)
      expect(pollutedNames()).toBe(0)
    }
  )

  it('counts a member that was deleted', () => {
    // Scenario: a deleted member is a change as much as a replaced one, and is put back after.
    let counted = 0
    const original = Object.getOwnPropertyDescriptor(Array.prototype, 'map') as PropertyDescriptor
    delete (Array.prototype as unknown as Record<string, unknown>)['map']
    try {
      counted = pollutedNames()
    } finally {
      Object.defineProperty(Array.prototype, 'map', original)
    }
    expect(counted).toBeGreaterThan(0)
  })

  it('counts a member swapped for the same engine function of another realm, by identity', () => {
    // Scenario: a function with the engine's own text but not the one this module met is a replacement.
    const other = runInNewContext('Array.prototype.map') as () => void
    let counted = 0
    replacing(0, 'map', { value: other, writable: true, configurable: true }, () => {
      counted = pollutedNames()
    })
    expect(counted).toBeGreaterThan(0)
  })

  it.each(ITERATION)(
    'counts %s once it is replaced, the iteration the decision paths do without a call',
    (_label, target, name) => {
      // Scenario: a for...of, a spread, a destructuring or new Set(list) on a decision path reaches these members
      // with no call in the source, so the list of built-in calls cannot see them; replacing one is a change.
      const original = Object.getOwnPropertyDescriptor(target, name) as PropertyDescriptor
      let counted = 0
      Object.defineProperty(target, name, {
        value: function replaced(): void {},
        writable: true,
        configurable: true
      })
      try {
        counted = pollutedNames()
      } finally {
        Object.defineProperty(target, name, original)
      }
      expect(counted).toBeGreaterThan(0)
      expect(pollutedNames()).toBe(0)
    }
  )

  it('counts every member of the table, in a copy of the module that this test loads', async () => {
    // Scenario: the table is read when the module loads, so a copy loaded here is the one this test depends on; a
    // row with a wrong name or object cannot be replaced and fails here, and a row that lost its names is seen by
    // the number of members of each row, the one thing a sweep over the rows cannot see.
    const guard = await loadGuard()
    expect(guard.GUARDED_BUILTINS.map(([, names]) => names.length)).toEqual([
      10, 11, 2, 3, 1, 1, 1, 1, 1, 7, 3, 1, 1, 1, 1
    ])
    guard.GUARDED_BUILTINS.forEach(([, names], row) => {
      names.forEach((name) => {
        const target = guard.readBuiltins()[row] as object
        const original = Object.getOwnPropertyDescriptor(target, name) as PropertyDescriptor
        Object.defineProperty(target, name, {
          value: function replaced(): void {},
          writable: true,
          configurable: true
        })
        let counted = 0
        try {
          counted = guard.pollutedNames()
        } finally {
          Object.defineProperty(target, name, original)
        }
        expect(counted).toBeGreaterThan(0)
      })
    })
    expect(guard.pollutedNames()).toBe(0)
  })

  it('counts the iteration that empties the list of redacted query parameters, before anything is read from it', () => {
    // Scenario: with the next of an array iterator answering done, buildRedactedQueryParams returns no name at all,
    // so the query secrets would be exported; the guard counts it, and the start refuses on that count.
    const iterator = Object.getPrototypeOf([][Symbol.iterator]()) as { next: () => unknown }
    const original = iterator.next
    let params = -1
    let counted = 0
    iterator.next = (): unknown => ({ done: true, value: undefined })
    try {
      params = buildRedactedQueryParams(['x']).length
      counted = pollutedNames()
    } finally {
      iterator.next = original
    }
    expect(params).toBe(0)
    expect(counted).toBeGreaterThan(0)
  })

  it('counts one, with no error, when a built-in cannot be read as an object at all', () => {
    // Scenario: a global that was replaced by null makes the read of its members throw; that is not clean.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'Reflect') as PropertyDescriptor
    Object.defineProperty(globalThis, 'Reflect', { ...original, value: null })
    let counted = 0
    try {
      counted = pollutedNames()
    } finally {
      Object.defineProperty(globalThis, 'Reflect', original)
    }
    expect(counted).toBe(1)
  })

  it('reads, for the fresh realm and for this one, the same object in every row', () => {
    // Scenario: the expression that the fresh realm evaluates and the reader of this realm are two spellings
    // of one table; a row that names a different object in each would compare the wrong things.
    const here = readBuiltins()
    expect(here).toHaveLength(GUARDED_BUILTINS.length)
    GUARDED_BUILTINS.forEach(([expression], at) => {
      expect((0, eval)(expression)).toBe(here[at])
    })
  })

  it('counts nothing while then, catch, finally and the statics of Promise are wrapped, as a tracing agent does', () => {
    // Scenario: context managers and APMs wrap the promise machinery by design, so a host that does is not
    // refused; the export decision awaits native promises and reads none of these names.
    const wrapped: [object, string][] = [
      [Promise.prototype, 'then'],
      [Promise.prototype, 'catch'],
      [Promise.prototype, 'finally'],
      [Promise, 'resolve'],
      [Promise, 'all'],
      [Promise, 'allSettled']
    ]
    const saved = wrapped.map(([target, name]) => Object.getOwnPropertyDescriptor(target, name))
    wrapped.forEach(([target, name]) =>
      Object.defineProperty(target, name, {
        value: function wrapper(): void {},
        configurable: true,
        writable: true
      })
    )
    try {
      expect(pollutedNames()).toBe(0)
    } finally {
      wrapped.forEach(([target, name], at) =>
        Object.defineProperty(target, name, saved[at] as PropertyDescriptor)
      )
    }
  })

  it('counts a then on Array.prototype or Function.prototype, one each, and nothing once it is gone', () => {
    // Scenario: a value that is an array or a function and is resolved into a promise is read for a then, so one
    // planted on either prototype is as unsafe as one on Object.prototype; each is counted once, and the count
    // returns to zero when the name is removed.
    for (const target of [Array.prototype, Function.prototype] as object[]) {
      expect(pollutedNames()).toBe(0)
      Object.defineProperty(target, 'then', { value: () => undefined, configurable: true })
      try {
        expect(pollutedNames()).toBe(1)
      } finally {
        delete (target as Record<string, unknown>)['then']
      }
      expect(pollutedNames()).toBe(0)
    }
  })

  it('counts a changed constructor of Promise.prototype, and nothing once it is back', () => {
    // Scenario: a then reads the constructor of the promise it is called on, so a getter or another function there
    // is a change the guard refuses to export beside.
    const original = Object.getOwnPropertyDescriptor(
      Promise.prototype,
      'constructor'
    ) as PropertyDescriptor
    const before = pollutedNames()
    try {
      Object.defineProperty(Promise.prototype, 'constructor', {
        configurable: true,
        get: () => Promise
      })
      expect(pollutedNames()).toBe(before + 1)
      Object.defineProperty(Promise.prototype, 'constructor', {
        configurable: true,
        writable: true,
        value: function Other() {}
      })
      expect(pollutedNames()).toBe(before + 1)
    } finally {
      Object.defineProperty(Promise.prototype, 'constructor', original)
    }
    expect(pollutedNames()).toBe(before)
  })

  describe('a Promise that was changed before this copy loaded', () => {
    /** Loads a fresh copy of the guard while `prepare` has changed the process, and counts before it restores it. */
    function countedAfterLoad(prepare: () => () => void): number {
      let count = -1
      jest.isolateModules(() => {
        const restore = prepare()
        try {
          count = (
            jest.requireActual('./prototype-guard') as typeof import('./prototype-guard')
          ).pollutedNames()
        } finally {
          restore()
        }
      })
      return count
    }

    const slot = (): PropertyDescriptor =>
      Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor') as PropertyDescriptor

    it('counts a constructor of Promise.prototype that was set before the load, which the copy then captures', () => {
      // Scenario: a host sets the slot to its own function before a copy loads (the nest bundle loads after the
      // preload); the copy captures it, and the count still names the change because it is not the engine's Promise.
      const original = slot()
      const count = countedAfterLoad(() => {
        Object.defineProperty(Promise.prototype, 'constructor', {
          ...original,
          value: function Host(): void {}
        })
        return (): Promise<unknown> =>
          Object.defineProperty(Promise.prototype, 'constructor', original)
      })
      expect(count).toBeGreaterThan(0)
    })

    it('counts a constructor that links back to the prototype but reads as another function', () => {
      // Scenario: the planted function takes `Promise.prototype` as its own `prototype`, so the slot and the link both
      // agree; its text is not the engine's.
      const original = slot()
      const count = countedAfterLoad(() => {
        const host = function Host(): void {}
        host.prototype = Promise.prototype
        Object.defineProperty(Promise.prototype, 'constructor', { ...original, value: host })
        return (): Promise<unknown> =>
          Object.defineProperty(Promise.prototype, 'constructor', original)
      })
      expect(count).toBeGreaterThan(0)
    })

    it('counts a constructor slot that was deleted before the load, and the count does not throw', () => {
      // Scenario: a host deletes `Promise.prototype.constructor` before a copy loads; the capture falls back to the
      // global and the guard counts the missing slot instead of throwing at the caller.
      const original = slot()
      const count = countedAfterLoad(() => {
        Reflect.deleteProperty(Promise.prototype, 'constructor')
        return (): Promise<unknown> =>
          Object.defineProperty(Promise.prototype, 'constructor', original)
      })
      expect(count).toBeGreaterThan(0)
    })

    it('counts nothing for a global Promise that a host replaced with a subclass before the load', () => {
      // Scenario: a zone or Bluebird style host replaces `globalThis.Promise` before load; the engine's prototype is
      // untouched, so the process is not polluted and the start is not refused forever.
      const real = globalThis.Promise
      class Zoneish extends (real as unknown as new (executor: () => void) => object) {}
      const count = countedAfterLoad(() => {
        globalThis.Promise = Zoneish as unknown as PromiseConstructor
        return (): void => {
          globalThis.Promise = real
        }
      })
      expect(count).toBe(0)
    })
  })
})

describe('Promise[Symbol.species] in the baseline', () => {
  const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species) as PropertyDescriptor

  it('counts a species getter that answers with a fake constructor, and a throwing one', () => {
    // Scenario: a persistent species getter makes every `then` a dependency calls build a promise from a constructor the
    // host chose, so a realm check that ignores it passes while the answer is forged; a throwing getter breaks the
    // `then` before a reaction is attached. Both must count, and the count must go back when the getter is restored.
    const counted: number[] = []
    try {
      Object.defineProperty(Promise, Symbol.species, { configurable: true, get: () => Object })
      counted.push(pollutedNames())
      Object.defineProperty(Promise, Symbol.species, {
        configurable: true,
        get: () => {
          throw new Error('species')
        }
      })
      counted.push(pollutedNames())
    } finally {
      Object.defineProperty(Promise, Symbol.species, species)
    }
    expect(counted.every((count) => count > 0)).toBe(true)
    expect(pollutedNames()).toBe(0)
  })

  it('counts a data species beside an Object.prototype.get that names the original getter', () => {
    // Scenario: the slot became data holding a fake constructor while `Object.prototype.get` names the real getter, so
    // a `get` read through the chain would match; the data slot still differs from the fresh realm's accessor through
    // its own `value`, and counts. The own-only read itself is held by the test of a getter planted under a field name.
    const original = species.get as () => unknown
    let counted = 0
    try {
      Object.defineProperty(Object.prototype, 'get', { configurable: true, value: original })
      Object.defineProperty(Promise, Symbol.species, {
        __proto__: null,
        configurable: true,
        value: Object
      } as PropertyDescriptor)
      counted = pollutedNames()
    } finally {
      Object.defineProperty(Promise, Symbol.species, species)
      Reflect.deleteProperty(Object.prototype, 'get')
    }
    expect(counted).toBeGreaterThan(0)
    expect(pollutedNames()).toBe(0)
  })
})
