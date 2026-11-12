/**
 * @fileoverview Jest resolver that keeps a unit spec from loading `supertest`.
 * @layer scripts
 *
 * A unit spec drives the code with doubles and opens no socket; a case that needs a real server
 * belongs in `test/e2e`. The lint gate bans the spellings a selector can name. A resolver sees
 * every way a module is asked for, whatever the spelling: a name built at run time, an aliased or
 * destructured `jest.requireActual`, `.call`, an interpolated template, a dynamic `import()`, a
 * subpath. It refuses the package only for a module under `src/`, which is where unit specs live,
 * so the end-to-end specs under `test/e2e` still load it.
 *
 * Jest runs it for each resolution with the directory of the requiring file as `basedir`.
 */
const path = require('node:path')

const SRC = path.resolve(__dirname, '..', 'src') + path.sep
const FORBIDDEN = /^supertest(\/|$)/
// Loading it throws, with the reason; a thrown resolver error would read as a missing module.
const STUB = path.resolve(__dirname, 'jest-no-sockets.supertest.cjs')

module.exports = (request, options) => {
  if (FORBIDDEN.test(request) && (options.basedir + path.sep).startsWith(SRC)) {
    return STUB
  }
  return options.defaultResolver(request, options)
}
