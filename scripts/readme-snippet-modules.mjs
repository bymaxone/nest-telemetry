/**
 * @fileoverview Turns the README's file headers into modules a snippet can import.
 * @layer scripts
 *
 * A relative import in a README snippet resolves to the snippet that shows the file: its
 * first line names it (`// app.module.ts`). The first snippet naming a file stands for it,
 * and whatever that snippet exports is what an importer gets, so a wrong export name is an
 * error instead of an `any`.
 *
 * The gate directory holds a symlink to the repository itself, so a header must never
 * name a path or replace a file the gate wrote. The module path is built from a plain
 * name, never over an existing file, and created with an exclusive write.
 */

import { lstatSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Where the module for a README file header goes, built from a plain name so that no
 * header can reach outside the gate directory or replace a file the gate wrote. The name is
 * one plain segment (a letter or digit first, then at most 99 word characters, dots and
 * hyphens), the target must not exist, even as a dangling symlink (a snippet, the
 * prelude), it must resolve inside the gate directory, and the file system must be able
 * to answer for it. Returns the path, or the reason there is none.
 */
export function moduleFilePath(gateDir, file) {
  if (!/^[A-Za-z0-9][\w.-]{0,99}$/.test(file)) return { reason: 'is not a plain file name' }
  const target = join(gateDir, `${file}.ts`)
  const inside = relative(gateDir, target)
  if (inside.startsWith('..') || inside.includes(sep)) {
    return { reason: 'leaves the gate directory' }
  }
  try {
    if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
      return { reason: 'is a file the gate writes itself' }
    }
  } catch {
    return { reason: 'cannot be checked as a file name' }
  }
  return { path: target }
}

/**
 * Writes a module for each README snippet whose first line names a file, re-exporting that
 * snippet. `snippets` holds each snippet's source and the name of the file the gate wrote
 * it to (`snippet-01`). Returns the problems found, one line each, for the caller to
 * report: a header that is not a usable file name is reported and never written.
 */
export function writeShownModules(gateDir, snippets) {
  const problems = []
  const shown = new Set()
  for (const { raw, snippet } of snippets) {
    const file = /^\/\/\s*([\w.-]+)\.tsx?\b/.exec(raw)?.[1]
    if (file === undefined || shown.has(file)) continue
    const target = moduleFilePath(gateDir, file)
    if (target.path === undefined) {
      problems.push(`README header "// ${file}.ts" in ${snippet} ${target.reason}`)
      continue
    }
    shown.add(file)
    const tail = /^export\s+default\b/m.test(raw) ? `export { default } from './${snippet}'\n` : ''
    // `wx`: create, never overwrite, whatever happened between the check and the write.
    writeFileSync(target.path, `export * from './${snippet}'\n${tail}`, { flag: 'wx' })
  }
  return problems
}
