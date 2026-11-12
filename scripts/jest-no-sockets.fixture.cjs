/**
 * @fileoverview A helper outside `src/` that loads `supertest` and uses it, for the spec that pins
 * the runtime guard.
 * @layer scripts
 *
 * The resolver refuses the package for a module under `src/` only, so a unit spec that goes
 * through a helper outside it is not stopped there. `supertest` starts the server it is given
 * with `listen`, which the setup of the guard replaces.
 */
const http = require('node:http')

/**
 * Load the package by name and ask it for a request against a fresh server.
 *
 * @param {string} name - The package name, passed in so no selector can see it.
 * @returns {unknown} What the package answers.
 */
module.exports = function startRequest(name) {
  return require(name)(http.createServer()).get('/')
}
