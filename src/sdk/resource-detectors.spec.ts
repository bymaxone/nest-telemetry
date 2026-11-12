import type { ResourceDetector } from '@opentelemetry/resources'

import { selectResourceDetectors, withoutAttributes } from './resource-detectors'
import type { DetectorMap } from './resource-detectors'

/** A detector that reports one attribute of its own plus the two command-line attributes. */
function fakeDetector(name: string): ResourceDetector {
  return {
    detect: () => ({
      attributes: {
        [`${name}.id`]: name,
        'process.command_args': ['node', '--api-key=secret'],
        'process.command_line': 'node --api-key=secret'
      }
    })
  }
}

const detectors: DetectorMap = {
  env: fakeDetector('env'),
  host: fakeDetector('host'),
  os: fakeDetector('os'),
  process: fakeDetector('process'),
  serviceinstance: fakeDetector('serviceinstance')
}

/** The attribute names a detector reports. */
function reported(detector: ResourceDetector | undefined): string[] {
  return Object.keys(detector?.detect().attributes ?? {})
}

describe('withoutAttributes', () => {
  it('leaves out the named attributes and keeps the rest', () => {
    // Scenario: the process detector reports pid and command line together; only the command
    // line goes.
    const wrapped = withoutAttributes(
      { detect: () => ({ attributes: { 'process.pid': 1, 'process.command_args': ['x'] } }) },
      ['process.command_args']
    )
    expect(wrapped.detect().attributes).toEqual({ 'process.pid': 1 })
  })

  it('passes the detection config through to the wrapped detector', () => {
    // Scenario: detectors may read the config they are given, so the wrapper forwards it.
    const detect = jest.fn(() => ({ attributes: { a: 1 } }))
    const config = {}
    withoutAttributes({ detect }, []).detect(config)
    expect(detect).toHaveBeenCalledWith(config)
  })

  it('keeps asynchronous attribute values as they are', async () => {
    // Scenario: a detector may report a promise for an attribute it resolves later.
    const wrapped = withoutAttributes(
      { detect: () => ({ attributes: { slow: Promise.resolve('value'), gone: 'x' } }) },
      ['gone']
    )
    const attributes = wrapped.detect().attributes ?? {}
    await expect(attributes['slow']).resolves.toBe('value')
    expect(attributes).not.toHaveProperty('gone')
  })

  it('keeps the other parts of the detected resource', () => {
    // Scenario: the schema URL a detector reports is not an attribute and is not lost.
    const wrapped = withoutAttributes(
      { detect: () => ({ schemaUrl: 'https://schema.example.test', attributes: { a: 1 } }) },
      ['a']
    )
    expect(wrapped.detect()).toEqual({ schemaUrl: 'https://schema.example.test', attributes: {} })
  })

  it('reports a detector that found nothing as an empty attribute set', () => {
    // Scenario: a detector with no attributes has nothing to filter and nothing to lose.
    expect(withoutAttributes({ detect: () => ({}) }, ['a']).detect()).toEqual({ attributes: {} })
  })
})

describe('selectResourceDetectors', () => {
  /** The names of the detectors a selection runs, read from what each one reports first. */
  function selected(selection: readonly string[] | undefined, keepCommandLine = true): string[] {
    return selectResourceDetectors(selection, detectors, keepCommandLine).map(
      (detector) => reported(detector)[0]?.replace('.id', '') ?? ''
    )
  }

  const DEFAULT = ['serviceinstance', 'process', 'host', 'os', 'env']
  const ALL = ['host', 'os', 'serviceinstance', 'process', 'env']

  it.each<[string, readonly string[] | undefined, string[]]>([
    ['nothing selected: the SDK default order', undefined, DEFAULT],
    ['a set but empty selection', [], []],
    ['"all": the order of the SDK table', ['all'], ALL],
    ['"none"', ['none'], []],
    ['"none" named alongside others', ['process', 'none'], []],
    ['"all" named alongside "none"', ['none', 'all'], ALL],
    ['the specification name "process"', ['process'], ['process']],
    ['the specification name "host", which covers the os attributes', ['host'], ['host', 'os']],
    [
      'the specification name "service", which covers the instance id and the environment',
      ['service'],
      ['serviceinstance', 'env']
    ],
    ['the legacy name "os"', ['os'], ['os']],
    ['the legacy name "serviceinstance"', ['serviceinstance'], ['serviceinstance']],
    ['the legacy name "env"', ['env'], ['env']],
    ['both "host" and "os", each detector once', ['host', 'os'], ['host', 'os']],
    ['"os" before "host", each detector once', ['os', 'host'], ['os', 'host']],
    ['names in the order given', ['process', 'host'], ['process', 'host', 'os']],
    ['an unknown name, skipped', ['bogus', 'process'], ['process']],
    ['a name in another letter case, which is unknown', ['Process'], []],
    [
      'names that are members of Object.prototype',
      ['constructor', '__proto__', 'toString', 'hasOwnProperty'],
      []
    ]
  ])('selects for %s', (_label, selection, expected) => {
    // Scenario: every way OTEL_NODE_RESOURCE_DETECTORS can name detectors, under the specification's
    // names and the SDK's legacy ones; whatever the name, the result is a list of detectors.
    expect(selected(selection)).toEqual(expected)
  })

  it('removes the process command line from the process detector only', () => {
    // Scenario: the command line goes by default, and the other detectors, whose attributes the
    // operator chose, are not touched.
    const run = selectResourceDetectors(undefined, detectors, false)
    expect(reported(run[1])).toEqual(['process.id'])
    expect(reported(run[0])).toEqual([
      'serviceinstance.id',
      'process.command_args',
      'process.command_line'
    ])
  })

  it('keeps the process command line when the host exports it explicitly', () => {
    // Scenario: with exportProcessCommandArgs the process detector is the SDK's own.
    expect(selectResourceDetectors(undefined, detectors, true)[1]).toBe(detectors.process)
  })

  it('still removes the command line from a process detector selected by name', () => {
    // Scenario: choosing the detector explicitly does not bring the command line back.
    const [only] = selectResourceDetectors(['process'], detectors, false)
    expect(reported(only)).toEqual(['process.id'])
  })

  it('does not return a detector that was not selected', () => {
    // Scenario: the list holds the detector objects themselves, not copies, so a selection of one
    // name never carries another.
    expect(selectResourceDetectors(['os'], detectors, true)).toEqual([detectors.os])
  })
})
