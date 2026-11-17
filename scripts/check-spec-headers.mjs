/**
 * @fileoverview Spec-header gate: every spec file under `src` and `test` opens with a block comment
 * that states what the file tests and which layer it belongs to.
 * @layer scripts
 *
 * The review bots read a spec cold, without the source open beside it, and keep reporting one that does
 * not say what it covers or where it sits. The header is the one place a reader finds that, so it is a
 * gate and not a habit: the comment must come before the first statement, carry a layer marker
 * (`@layer sdk` or `Layer: sdk.`) from the fixed list below, and say something besides the marker.
 *
 * Usage: node scripts/check-spec-headers.mjs [root]
 *   root  repository root to check (default: the package root)
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Directories whose spec files are checked, relative to the root. */
const SPEC_ROOTS = ['src', 'test']

/** Spec files: unit (`*.spec.ts`) and end-to-end (`*.e2e-spec.ts`). */
const SPEC_FILE = /\.(?:e2e-)?spec\.ts$/

/** Shortest text, outside the layer marker, that can still state a purpose. */
const MIN_PURPOSE_LENGTH = 20

/** A `Layer: x` sentence or an `@layer x` tag; the first word after it names the layer. */
const LAYER_MARKER = /(?:\bLayer:|@layer)\s+([A-Za-z0-9-]+)/i

/**
 * The layers a spec may declare: the three subpaths of the package, the end-to-end suite, and the
 * repository-level specs that read the source tree instead of running it.
 */
export const LAYERS = ['sdk', 'register', 'nest', 'e2e', 'repository']

/**
 * Why `source` has no valid header, or `null` when it has one.
 *
 * @param {string} source The spec file's text.
 * @returns {string | null} The problem in one sentence, or `null`.
 */
export function headerProblem(source) {
  const text = source.trimStart() // trimStart also drops a byte-order mark
  const end = text.startsWith('/**') ? text.indexOf('*/') : -1
  if (end === -1) {
    return 'does not open with a /** */ block comment'
  }
  const body = text
    .slice(3, end)
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join(' ')
  const marker = LAYER_MARKER.exec(body)
  if (marker === null) {
    return 'header has no layer marker (`@layer <layer>` or `Layer: <layer>.`)'
  }
  const layer = (marker[1] ?? '').toLowerCase()
  if (!LAYERS.includes(layer)) {
    return `header names the layer "${layer}", which is not one of ${LAYERS.join(', ')}`
  }
  const purpose = body
    .replace(LAYER_MARKER, '')
    .replace(/@fileoverview/gi, '')
    .trim()
  if (purpose.length < MIN_PURPOSE_LENGTH) {
    return 'header states a layer but not what the file tests'
  }
  return null
}

/**
 * Every spec file below `dir`, depth first; a directory that does not exist has none.
 *
 * @param {string} dir Directory to walk.
 * @returns {string[]} Absolute paths, sorted.
 */
function specFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        return entry.name === 'node_modules' ? [] : specFiles(path)
      }
      return SPEC_FILE.test(entry.name) ? [path] : []
    })
    .sort()
}

/**
 * Runs the gate and exits non-zero when any header is bad, or when there is no spec to check.
 *
 * @param {string | undefined} rootArg Repository root to check; the package root when omitted.
 */
function main(rootArg) {
  const root = rootArg ?? join(fileURLToPath(new URL('.', import.meta.url)), '..')
  const files = SPEC_ROOTS.flatMap((dir) => specFiles(join(root, dir)))
  if (files.length === 0) {
    console.error('No spec file found: the gate would pass on nothing.')
    process.exit(1)
  }
  const failures = files
    .map((file) => [relative(root, file), headerProblem(readFileSync(file, 'utf8'))])
    .filter(([, problem]) => problem !== null)
  if (failures.length > 0) {
    for (const [file, problem] of failures) {
      console.error(`${file}: ${problem}`)
    }
    console.error(`\n${failures.length} spec file(s) without a purpose and layer header.`)
    process.exit(1)
  }
  console.log(`Every spec file (${files.length}) opens with a purpose and layer header.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv[2])
}
