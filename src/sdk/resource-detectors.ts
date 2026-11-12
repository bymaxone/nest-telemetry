/**
 * @fileoverview Selection of the resource detectors, and removal of the process command line from
 * what they report.
 * @layer sdk
 *
 * The OTel SDK runs the process detector by default, and that detector reports the whole command
 * line of the process. Command-line arguments are a common carrier of secrets, so the library runs
 * its own selection and leaves them out unless the host opts in.
 */
import type { ResourceDetector } from '@opentelemetry/resources'

/** The detectors the OTel SDK knows by name in `OTEL_NODE_RESOURCE_DETECTORS`. */
export interface DetectorMap {
  readonly env: ResourceDetector
  readonly host: ResourceDetector
  readonly os: ResourceDetector
  readonly process: ResourceDetector
  readonly serviceinstance: ResourceDetector
}

/** The attributes that carry the command line of the process. */
const COMMAND_LINE_ATTRIBUTES = ['process.command_args', 'process.command_line'] as const

/** The order the SDK runs its detectors in when `OTEL_NODE_RESOURCE_DETECTORS` is unset. */
const DEFAULT_ORDER = ['serviceinstance', 'process', 'host', 'os', 'env'] as const

/** The order the SDK's own table lists them in, which `all` selects. */
const ALL_ORDER = ['host', 'os', 'serviceinstance', 'process', 'env'] as const

/**
 * Wraps a detector so the named attributes are left out of what it reports.
 *
 * @param detector - The detector to wrap.
 * @param names - Attribute names to remove.
 * @returns A detector that reports everything the original does except those names.
 */
export function withoutAttributes(
  detector: ResourceDetector,
  names: readonly string[]
): ResourceDetector {
  return {
    detect: (config): ReturnType<ResourceDetector['detect']> => {
      const detected = detector.detect(config)
      return {
        ...detected,
        // Spreading an absent attribute map yields an empty one, so a detector that found nothing
        // needs no case of its own.
        attributes: Object.fromEntries(
          Object.entries({ ...detected.attributes }).filter(([name]) => !names.includes(name))
        )
      }
    }
  }
}

/**
 * Chooses the resource detectors, the way `OTEL_NODE_RESOURCE_DETECTORS` selects them for the SDK.
 *
 * @param selection - The names in `OTEL_NODE_RESOURCE_DETECTORS`, or `undefined` when it is unset.
 * @param detectors - The detectors by name.
 * @param keepCommandLine - Whether the process command line stays in the resource.
 * @returns The detectors to run, in order. Unknown names are skipped, as the SDK skips them.
 */
export function selectResourceDetectors(
  selection: readonly string[] | undefined,
  detectors: DetectorMap,
  keepCommandLine: boolean
): ResourceDetector[] {
  const available: DetectorMap = keepCommandLine
    ? detectors
    : { ...detectors, process: withoutAttributes(detectors.process, COMMAND_LINE_ATTRIBUTES) }
  if (selection?.includes('none') === true && !selection.includes('all')) {
    return []
  }
  let names: readonly string[] = DEFAULT_ORDER
  if (selection?.includes('all') === true) {
    names = ALL_ORDER
  } else if (selection !== undefined) {
    names = selection
  }
  return names.flatMap((name) => (name in available ? [available[name as keyof DetectorMap]] : []))
}
