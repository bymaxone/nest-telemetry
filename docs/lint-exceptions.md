# Lint exceptions

The lint rules that are off for a reason of their own, why they are off, and what guards the risk
instead. `pnpm lint` runs with `--max-warnings 0`.

## `security/detect-object-injection` — off everywhere

The rule reports every computed access whose key is a variable (`object[name]`, `list[at]`). It has no
option and recognizes no form of that access as safe. The plugin's
[README](https://github.com/eslint-community/eslint-plugin-security) says the project "finds a lot of
false positives which need triage by a human". Its
[advice](https://github.com/eslint-community/eslint-plugin-security/blob/main/docs/the-dangers-of-square-bracket-notation.md)
is to keep user input out of property names or to filter names through a list, and doing either does
not silence the rule. A rewrite through `Reflect.get` or a type assertion would be the same access with
the report hidden, and `Array.prototype.at` adds a built-in call that
`src/builtin-calls.spec.ts` rejects unless it is listed.

Guards on prototype access in `src/sdk`:

- the configuration records `assembly.ts` merges by instrumentation name have no prototype;
- `readOwnOrClass` ignores a value planted on the root prototype, except behind a Proxy
  (`option-kinds.ts`);
- list entries are read behind an own-property check (`option-kinds.ts`);
- `pollutedNames` makes telemetry refuse to start, and its OTLP exporters refuse to send, beside a
  polluted `Object.prototype` (`prototype-guard.ts`).

The specs in `src/sdk` plant names and test those guards.

## `security/detect-non-literal-regexp` — off where a host's expression is copied

The rule is configured for the sources under `src/`, not for specs or scripts.

`src/sdk/ignore-paths.ts` and `src/sdk/option-kinds.ts` copy a regular expression that the host gave,
so that its `lastIndex` and later changes stay outside the library. The
[rule](https://github.com/eslint-community/eslint-plugin-security/blob/main/docs/rules/detect-non-literal-regexp.md)
reports a `new RegExp` whose source is not static. The source of a copy is the host's by
definition: it cannot be written as a literal, and escaping it would change what it matches. In both
files the only string compiled is the `source` of an expression that already exists.
