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
  it('runs the SDK default detectors, in its order, when nothing is selected', () => {
    // Scenario: OTEL_NODE_RESOURCE_DETECTORS is unset, so the five built-in detectors run in the
    // order the SDK itself uses.
    const selected = selectResourceDetectors(undefined, detectors, false)
    expect(selected.map((detector) => reported(detector)[0])).toEqual([
      'serviceinstance.id',
      'process.id',
      'host.id',
      'os.id',
      'env.id'
    ])
  })

  it('removes the process command line from the process detector only', () => {
    // Scenario: the command line goes by default, and the other detectors, whose attributes the
    // operator chose, are not touched.
    const selected = selectResourceDetectors(undefined, detectors, false)
    expect(reported(selected[1])).toEqual(['process.id'])
    expect(reported(selected[0])).toEqual([
      'serviceinstance.id',
      'process.command_args',
      'process.command_line'
    ])
  })

  it('keeps the process command line when the host exports it explicitly', () => {
    // Scenario: with exportProcessCommandArgs the process detector is the SDK's own.
    const selected = selectResourceDetectors(undefined, detectors, true)
    expect(selected[1]).toBe(detectors.process)
  })

  it('runs every detector for "all", in the order of the SDK\'s own table', () => {
    // Scenario: the SDK maps "all" to its table order, which differs from its default list.
    const selected = selectResourceDetectors(['all'], detectors, true)
    expect(selected).toEqual([
      detectors.host,
      detectors.os,
      detectors.serviceinstance,
      detectors.process,
      detectors.env
    ])
  })

  it('lets "all" win over "none" when both are named', () => {
    // Scenario: the SDK checks for "all" first.
    expect(selectResourceDetectors(['none', 'all'], detectors, true)).toHaveLength(5)
  })

  it('runs no detector when "none" is named alongside others', () => {
    // Scenario: the SDK returns nothing as soon as "none" appears, unless "all" does too.
    expect(selectResourceDetectors(['process', 'none'], detectors, false)).toEqual([])
  })

  it('runs no detector for "none"', () => {
    // Scenario: the operator turns resource detection off.
    expect(selectResourceDetectors(['none'], detectors, false)).toEqual([])
  })

  it('runs the named detectors in the order given, ignoring unknown names', () => {
    // Scenario: a subset selection, with a name the SDK would skip with a warning.
    const selected = selectResourceDetectors(['process', 'bogus', 'host'], detectors, true)
    expect(selected).toEqual([detectors.process, detectors.host])
  })

  it('still removes the command line from a process detector selected by name', () => {
    // Scenario: choosing the detector explicitly does not bring the command line back.
    const [selected] = selectResourceDetectors(['process'], detectors, false)
    expect(reported(selected)).toEqual(['process.id'])
  })
})
