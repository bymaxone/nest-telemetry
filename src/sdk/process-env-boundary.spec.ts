import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Every non-spec TypeScript file under a directory, as paths relative to it. */
function sourceFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path, base)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [path.slice(base.length + 1)]
      : []
  })
}

describe('process.env boundary', () => {
  it('is named by exactly one source file, the environment reader', () => {
    // Scenario: every other module receives its environment as a parameter, so the list of
    // variables the library reads is the list in one file.
    const src = join(__dirname, '..')
    const naming = sourceFiles(src).filter((file) =>
      /\bprocess\s*\.\s*env\b/.test(readFileSync(join(src, file), 'utf8'))
    )
    expect(naming).toEqual([join('sdk', 'environment.ts')])
  })
})
