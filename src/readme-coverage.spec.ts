/**
 * @fileoverview Pins that the README names every public export of every subpath and every
 * `OTEL_*` variable the environment reader names, so a feature cannot ship without its docs.
 * @layer repository
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import ts from 'typescript'

const ROOT = join(__dirname, '..')
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const SUBPATHS = ['sdk', 'register', 'nest', 'observability'] as const

/** The names one subpath's entry file exports, types included, read with the TypeScript compiler. */
function exportedNames(subpath: string): string[] {
  const entry = join(ROOT, 'src', subpath, 'index.ts')
  const program = ts.createProgram([entry], {
    strict: true,
    skipLibCheck: true,
    experimentalDecorators: true,
    esModuleInterop: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022
  })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(entry)
  const symbol = source === undefined ? undefined : checker.getSymbolAtLocation(source)
  return symbol === undefined ? [] : checker.getExportsOfModule(symbol).map((it) => it.name)
}

/** Whether the README mentions a name as a whole word, in code or in prose. */
function documented(name: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(README)
}

describe('the README against the public surface', () => {
  it.each(SUBPATHS)('names every export of the %s subpath', (subpath) => {
    // Scenario: a new export, option type or constant that the README never mentions is a feature
    // a reader cannot find; the failure names the missing names.
    const names = exportedNames(subpath)
    if (subpath !== 'register') expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => !documented(name))).toEqual([])
  })

  it('names every OTEL variable the environment reader names', () => {
    // Scenario: a variable the library reads is a setting a reader must be able to find.
    const environment = readFileSync(join(ROOT, 'src', 'sdk', 'environment.ts'), 'utf8')
    const variables = [...new Set(environment.match(/\bOTEL_[A-Z][A-Z0-9_]*[A-Z0-9]\b/g) ?? [])]
    expect(variables.length).toBeGreaterThan(8)
    expect(variables.filter((name) => !documented(name))).toEqual([])
  })
})
