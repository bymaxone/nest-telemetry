import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import prettierConfig from 'eslint-config-prettier'
import importPlugin from 'eslint-plugin-import'
import prettier from 'eslint-plugin-prettier'
import security from 'eslint-plugin-security'
import globals from 'globals'

// Messages and patterns of the rule that keeps a unit spec from opening a socket.
const NO_SOCKET =
  'A unit spec opens no socket. Use request and response doubles, or move the case to test/e2e.'
const NO_SERVER =
  'A unit spec starts no server. Use request and response doubles, or move the case to test/e2e.'
const SUPERTEST = '/^supertest(\\/|$)/'
const STARTS_A_SERVER = '/^(listen|createNestApplication)$/'

// Each way to load a module other than an import declaration, with the name given as a string and
// as a template literal, so that no loader has one spelling closed and the other open.
const JEST_LOADERS = '/^(requireActual|requireMock|createMockFromModule|genMockFromModule)$/'
const CALLS_THAT_LOAD = [
  "CallExpression[callee.name='require']",
  `CallExpression[callee.computed=false][callee.property.name=${JEST_LOADERS}]`,
  `CallExpression[callee.computed=true][callee.property.value=${JEST_LOADERS}]`,
  `CallExpression[callee.computed=true][callee.property.quasis.0.value.cooked=${JEST_LOADERS}]`
]
const LOADS_SUPERTEST = [
  ...CALLS_THAT_LOAD.flatMap((call) => [
    `${call}[arguments.0.value=${SUPERTEST}]`,
    `${call}[arguments.0.quasis.0.value.cooked=${SUPERTEST}]`
  ]),
  `ImportExpression[source.value=${SUPERTEST}]`,
  `ImportExpression[source.quasis.0.value.cooked=${SUPERTEST}]`
]

export default [
  // Global ignores — only build artifacts and coverage, NOT config files
  {
    // Every entry is anchored with `**/`, and must stay that way. A flat-config
    // ignore is ROOT-relative, so a bare `coverage/**` excludes the top-level
    // directory and nothing else — a nested one (a jest run with the wrong cwd
    // leaves `src/coverage/`) is then linted, and generated reporter JavaScript
    // that nobody wrote can fail CI on a rule it happens to trip.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/reports/**',
      '**/.stryker-tmp/**',
      // A declaration file the README-snippet gate copies into its compile fixture. No
      // block here gives `scripts/` a TypeScript parser, so the default parser would
      // reject it; Prettier still checks its formatting.
      '**/scripts/**/*.d.ts'
    ]
  },

  // Base recommended config
  js.configs.recommended,

  // TypeScript production files (Node-only library; no DOM, no JSX)
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      globals: {
        ...globals.node
      }
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
      security
    },
    settings: {
      // Required for `no-cycle` below to detect anything at all. The RESOLVER
      // decides where a specifier points; a separate DEPENDENCY PARSER decides
      // what the resolved file exports, and it skips in silence every extension
      // it cannot map — on a TypeScript project, all of them. Remove this line and
      // `--print-config` still reports `no-cycle` as [2] while a real cycle lints
      // clean, so a green run proves nothing about it.
      //
      // Only the rule that WALKS the graph needs this. `no-self-import` compares a
      // resolved path against the current file and fires either way, so it cannot
      // stand in as evidence that this mapping is present.
      'import/parsers': { '@typescript-eslint/parser': ['.ts'] },
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: './tsconfig.json'
        },
        node: {
          extensions: ['.js', '.ts']
        }
      }
    },
    rules: {
      // TypeScript — strict (zero `any`; explicit return types on exports)
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports'
        }
      ],
      '@typescript-eslint/no-empty-function': 'warn',

      // Code quality
      'prefer-const': 'error',
      'no-var': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // Security — block dynamic code evaluation
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-implied-eval': 'error',

      // Security — ban bare 'crypto' and external crypto/id packages (node:crypto only).
      // This is a Bymax-wide guard-rail: even libs that do not currently use crypto
      // must reach for node: builtins, never a third-party dependency, if they ever do.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'crypto', message: "Use 'node:crypto' with the node: prefix instead." },
            { name: 'bcrypt', message: 'Use node:crypto scrypt instead.' },
            { name: 'argon2', message: 'Use node:crypto scrypt instead.' },
            { name: 'uuid', message: 'Use crypto.randomUUID() from node:crypto instead.' },
            { name: 'nanoid', message: 'Use crypto.randomBytes() from node:crypto instead.' },
            { name: 'crypto-js', message: 'Use node:crypto instead.' }
          ]
        }
      ],

      // Security plugin rules
      'security/detect-object-injection': 'warn',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-possible-timing-attacks': 'error',

      // Import ordering — node: → external → internal → parent/sibling
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling'], 'index'],
          pathGroups: [
            {
              pattern: 'node:*',
              group: 'builtin',
              position: 'before'
            }
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true
          }
        }
      ],
      'import/no-cycle': 'error',
      'import/no-self-import': 'error'
    }
  },

  // Node.js ESM scripts. `.cjs` under `scripts/` belongs to the CommonJS block
  // below, not here: `sourceType` differs and one block cannot serve both.
  //
  // Every extension `pnpm lint` passes needs a block that matches it. Reached but
  // unmatched, a file falls through to `js.configs.recommended` with no
  // `globals.node`, and valid Node code fails `no-undef` — the gate rejecting a
  // non-defect. `.ts` under `scripts/` matches no block at all and is skipped in
  // silence, so keep these plain JavaScript.
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    plugins: {
      security
    },
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'security/detect-object-injection': 'warn'
    }
  },

  // CommonJS, for every `.cjs` the lint invocation reaches: root configs and any
  // helper under `scripts/`.
  //
  // `sourceType: 'commonjs'` must be explicit and must NOT be `'module'`. ESLint
  // infers commonjs from the extension and so supplies `module` and `require`,
  // but NOT `process`, `__dirname` or `Buffer` — a `.cjs` file using any of those
  // fails `no-undef` on valid code without `globals.node` here. Declaring
  // `'module'` instead is the opposite failure: ESM syntax in a `.cjs` file then
  // parses clean and no rule objects, while Node rejects it at require time with
  // `SyntaxError: Unexpected token 'export'`.
  {
    files: ['*.config.cjs', 'scripts/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    plugins: {
      security
    },
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'security/detect-object-injection': 'warn'
      //
      // The crypto guard-rail the ESM config block carries is deliberately NOT
      // repeated here. `no-restricted-imports` only sees `import` — measured, a
      // `.cjs` file doing `require('uuid')` and `require('crypto')` produces zero
      // findings, while the same import in a `.mjs` produces one. Declaring it
      // for `.cjs` would be a rule that reports nothing, which is the shape this
      // block exists to avoid. A `.cjs` file wanting that guarantee should be
      // `.mjs`.
    }
  },

  // Config files (tsup.config.ts, jest.config.ts, etc.) — TS parser, no type-aware project
  {
    files: ['*.config.ts', '*.config.mjs', '*.config.js'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      globals: {
        ...globals.node
      }
    },
    plugins: {
      security
    },
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'crypto', message: "Use 'node:crypto' with the node: prefix instead." },
            { name: 'bcrypt', message: 'Use node:crypto scrypt instead.' },
            { name: 'argon2', message: 'Use node:crypto scrypt instead.' },
            { name: 'uuid', message: 'Use crypto.randomUUID() from node:crypto instead.' },
            { name: 'nanoid', message: 'Use crypto.randomBytes() from node:crypto instead.' },
            { name: 'crypto-js', message: 'Use node:crypto instead.' }
          ]
        }
      ],
      'security/detect-object-injection': 'warn'
    }
  },

  // Test files — Jest + Node globals, relaxed rules.
  {
    // `**/*.spec.ts` does not match `foo.e2e-spec.ts` — a glob needs the literal
    // `.spec.ts`, and the hyphen breaks it. Unmatched, those files reach no block
    // with a TypeScript parser and every one of them reports
    // `Parsing error: Unexpected token {`. lint-staged runs eslint on staged
    // `*.ts` by basename, so leaving them out makes any commit that touches an
    // e2e spec fail the pre-commit hook on a parse error rather
    // than a defect, and the usual escape from a hook that cries wolf is to bypass
    // it entirely.
    files: ['**/*.spec.ts', '**/*.test.ts', '**/*.e2e-spec.ts', 'test/**/fixtures/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module'
      },
      globals: {
        ...globals.jest,
        ...globals.node
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-console': 'off'
    }
  },

  // A unit spec under `src/` opens no socket: it drives the code with request and response doubles.
  // A case that needs a real listening server belongs in `test/e2e`, where sockets are allowed.
  //
  // `no-restricted-imports` sees import declarations and re-exports only, so a `require`, a
  // dynamic `import()` and the Jest loaders (`requireActual`, `requireMock`,
  // `createMockFromModule`) have selectors of their own. The server is banned
  // by the member it is started through, not by the call: `app.listen`, `app['listen']`,
  // `const { listen } = app` and `app.listen.bind(app)` all name it, where a selector on the call
  // would miss the last two.
  //
  // The gate catches the idiomatic and accidental uses: literal names, in a string or a template
  // literal, through a member call or a destructured `listen`. Aliasing or destructuring a loader,
  // `.call`, a name built at run time, an interpolated template, a cast argument and
  // `module.require` are out of a selector's reach and are not checked here.
  //
  // Reading `listen` off a stub is banned the same way. A double defines it as an object-literal
  // property, which the rule leaves alone, and is not read back as a member.
  {
    files: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['supertest', 'supertest/**'], message: NO_SOCKET }] }
      ],
      'no-restricted-syntax': [
        'error',
        ...LOADS_SUPERTEST.map((selector) => ({ selector, message: NO_SOCKET })),
        ...[
          `MemberExpression[computed=false][property.name=${STARTS_A_SERVER}]`,
          `MemberExpression[computed=true][property.value=${STARTS_A_SERVER}]`,
          `MemberExpression[computed=true][property.quasis.0.value.cooked=${STARTS_A_SERVER}]`,
          `ObjectPattern > Property[key.name=${STARTS_A_SERVER}]`,
          `ObjectPattern > Property[key.value=${STARTS_A_SERVER}]`
        ].map((selector) => ({ selector, message: NO_SERVER }))
      ]
    }
  },

  // Formatting is an ERROR, on every path the lint invocation reaches.
  //
  // `'error'` and not `--max-warnings 0`: that flag raises EVERY warning, and
  // `security/detect-object-injection` is a warning on purpose in the scripts and
  // spec blocks. Formatting has to be able to fail the build without dragging an
  // unrelated rule up with it.
  //
  // `ci.yml` passes `run-format-check: false` and points here for the guarantee,
  // so this rule is the only thing gating formatting in CI. It has to cover every
  // path `pnpm lint` passes — a rule declared for a path the invocation never
  // reaches gates nothing.
  //
  // Options stay in `.prettierrc`; passing them here would let the two disagree.
  {
    files: ['**/*.{ts,mjs,cjs,js}'],
    plugins: { prettier },
    rules: {
      'prettier/prettier': 'error'
    }
  },

  // Prettier disables conflicting formatting rules (must be last)
  prettierConfig
]
