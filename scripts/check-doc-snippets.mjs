/**
 * Purpose: fail when a TypeScript snippet in `docs/` uses one of this package's own
 * symbols without importing or declaring it, or calls `this.something` that the class
 * shown in the same snippet does not define.
 *
 * Layer: repository tooling. Nothing here ships — `scripts/` is outside `files`.
 *
 * Why it exists: a snippet that names a symbol with nothing to resolve it — an
 * unimported constant, a `this.member` the class never defines — reads as correct
 * prose and misleads the reader. Reviewing prose by eye does not catch it; parsing does.
 *
 * How it decides. Three questions, all answered from the syntax tree rather than from
 * a regular expression, because a name inside a comment or a string is a MENTION and
 * only a name in an expression is a USE:
 *
 *   1. Does the snippet use a symbol this package declares in `src/` — an export or a
 *      module-level constant — while neither importing nor declaring it?
 *   2. Does it read `this.member` while declaring the enclosing class itself?
 *   3. Does it read `SOME_CONSTANT.KEY` for a key that constant does not define?
 *
 * Question 2 is asked only of snippets that show a complete class. A snippet that is
 * openly an excerpt of one method has no class to check against, and demanding one
 * would push every excerpt toward being a full file.
 *
 * Question 3 exists because question 1 cannot see it: a property is not a reference, so
 * an invented `DEFAULT_OPTIONS.REDACTION_DISABLED` reads as a use of
 * `DEFAULT_OPTIONS` — which IS imported — and passes.
 *
 * Deliberately NOT checked: a free local like `health` in an excerpt whose scope the
 * prose introduces. Flagging those means flagging every excerpt variable, and the
 * noise would retire the check. That case stays a matter of writing the prose well.
 *
 * The baseline. Findings that exist before the check can be fixed are recorded in
 * `doc-snippets-baseline.json`: a finding outside it fails, and an entry inside it that no
 * longer reproduces ALSO fails, so a fixed snippet cannot leave a stale line behind. The
 * list starts empty here. `--write-baseline` writes the INTERSECTION of the old baseline
 * and what still reproduces, so it can only remove entries; a defect introduced in the
 * same edit is not adopted by it and the run still fails. Widening what the check looks
 * at is the one case where the list legitimately grows, and that takes `--adopt-new`, a
 * separate flag so the decision is made on purpose and stated in the commit.
 *
 * Baseline entries are keyed by file and symbol, not by line, so editing prose above a
 * snippet does not churn the file. The cost of that choice is one real gap: a NEW
 * snippet in an already-listed file that omits the SAME symbol is absorbed by the
 * existing entry. Anything else — a new symbol, a new file, any `this.member` — fails.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const DOCS = join(ROOT, 'docs')

/** Recursively list files under `dir` that the caller's `filter` accepts. */
function walk(dir, filter) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, filter))
    else if (filter(full)) out.push(full)
  }
  return out
}

/**
 * Add every name a declaration binds, including through a destructuring pattern.
 *
 * `export const { ConfigurableModuleClass: Base, OPTIONS_TYPE } = builder()` binds two
 * names and matches none of the plain-identifier cases, so four real exports of this
 * package were invisible to the check and a snippet could use them unimported.
 *
 * @param name - A declaration's name node: an identifier or a binding pattern.
 * @param into - The set to add the bound names to.
 */
function collectBindingNames(name, into) {
  if (ts.isIdentifier(name)) {
    into.add(name.text)
    return
  }
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      // Array patterns contain holes (`[, second]`), which have no name to bind.
      if (ts.isBindingElement(element)) collectBindingNames(element.name, into)
    }
  }
}

/**
 * Every name this package declares at module level in `src/` — exported or not.
 * A snippet may legitimately use any of them, but only after saying where it came
 * from, and these are the only names whose origin this script can know.
 */
function internalSymbols() {
  const names = new Set()
  const files = walk(SRC, (f) => extname(f) === '.ts' && !f.includes('.spec.'))
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          collectBindingNames(decl.name, names)
        }
      } else if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement)) &&
        statement.name
      ) {
        names.add(statement.name.text)
      }
    }
  }
  return names
}

/**
 * Find the object literal inside an initializer, seeing through the wrappers this
 * repository actually uses: `{...} as const`, `{...} satisfies T`, parentheses, and
 * `Object.freeze({...} as const)` — which is how the reserved log keys are declared,
 * and the reason a first version of this function found no constants at all.
 *
 * @param node - The initializer expression to unwrap.
 * @returns The object literal, or `undefined` when the initializer is not one.
 */
function unwrapObjectLiteral(node) {
  let current = node
  for (;;) {
    if (current === undefined) return undefined
    if (ts.isObjectLiteralExpression(current)) return current
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression
      continue
    }
    // `Object.freeze(x)` / `Object.seal(x)`: the literal is the argument. Named
    // explicitly rather than accepting any one-argument call, because those two are
    // the only ones that RETURN their argument. Unwrapping `createThing({...})` the same way
    // would hand this script the options object as the variable's members, and every
    // `thing.run(...)` in the documentation would be reported as an undefined key.
    if (
      ts.isCallExpression(current) &&
      current.arguments.length === 1 &&
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === 'Object' &&
      (current.expression.name.text === 'freeze' || current.expression.name.text === 'seal')
    ) {
      current = current.arguments[0]
      continue
    }
    return undefined
  }
}

/**
 * The keys of every module-level constant object literal in `src/`, by object name.
 * A snippet writing `DEFAULT_OPTIONS.NO_SUCH_KEY` names something that does not
 * exist, which is how an invented constant reached this documentation once already —
 * the identifier check cannot see it, because a property is not a reference.
 */
function constantMembers() {
  const members = new Map()
  for (const file of walk(SRC, (f) => extname(f) === '.ts' && !f.includes('.spec.'))) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        const literal = unwrapObjectLiteral(decl.initializer)
        if (literal === undefined) continue
        const keys = new Set()
        for (const property of literal.properties) {
          if (
            property.name &&
            (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          ) {
            keys.add(property.name.text)
          }
        }
        if (keys.size > 0) members.set(decl.name.text, keys)
      }
    }
  }
  return members
}

/**
 * Extract every TypeScript block, with the line its fence opens on. Both spellings
 * count: `ts` and `typescript` are the same language to every renderer, and taking
 * only the long one left nine blocks silently outside the check.
 */
function snippetsOf(markdown) {
  const blocks = []
  const lines = markdown.split('\n')
  let start = -1
  let fence = 3
  let buffer = []
  for (const [index, line] of lines.entries()) {
    // Blockquoted snippets (`> ```typescript`) are code too — the task documents
    // quote most of theirs, and skipping them hid three of the reported defects.
    const bare = line.replace(/^>\s?/, '')
    if (start === -1) {
      // Two things vary besides the label. The fence can be LONGER than three
      // backticks — a snippet that itself shows a fenced example has to be wrapped in
      // more of them — and CommonMark allows up to three spaces of indentation before
      // it, which the task documents use. Requiring exactly three backticks at column
      // zero skipped six real blocks.
      const opening = /^ {0,3}(`{3,})(?:ts|typescript)\s*$/.exec(bare)
      if (opening) {
        fence = opening[1].length
        start = index + 1
        buffer = []
      }
    } else if (new RegExp(`^ {0,3}\`{${fence},}\\s*$`).test(bare)) {
      blocks.push({ line: start, code: buffer.join('\n') })
      start = -1
    } else {
      buffer.push(bare)
    }
  }
  if (start !== -1) {
    // Loudly, rather than dropping the block: an unclosed fence renders wrong AND
    // takes its snippet out of every check here, which is the silent no-op this
    // script exists to prevent. Guessing where it ends would be worse.
    throw new Error(`Unclosed TypeScript fence opened at line ${start}`)
  }
  return blocks
}

/** Names the snippet itself introduces: imports, declarations, parameters, bindings. */
function declaredIn(source) {
  const names = new Set()
  const visit = (node) => {
    if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) {
      if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text)
    } else if (
      ts.isVariableDeclaration(node) ||
      ts.isParameter(node) ||
      ts.isBindingElement(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isTypeParameterDeclaration(node)
    ) {
      if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/** Names the snippet reads as values or types — never a property, never a comment. */
function usedIn(source) {
  const names = new Set()
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isPropertySignature(parent) && parent.name === node) ||
        (ts.isPropertyDeclaration(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node) ||
        (ts.isQualifiedName(parent) && parent.right === node) ||
        // The left half of `{ DEFAULT_OPTIONS as KEYS }` names what is being
        // imported, it does not read it — the binding this snippet gets is `KEYS`.
        // Counting it as a use made the alias case report the ORIGINAL name as
        // unimported, and the run failed before the alias-aware key check could run.
        ((ts.isImportSpecifier(parent) || ts.isBindingElement(parent)) &&
          parent.propertyName === node)
      // A shorthand `{ safeMinLevel }` names the property AND reads the variable, so
      // it is a use — treating it as a declaration name would hide exactly the kind of
      // reference this script exists to find.
      const isOwnDeclarationName =
        parent &&
        parent.name === node &&
        !isPropertyName &&
        !ts.isShorthandPropertyAssignment(parent)
      if (!isPropertyName && !isOwnDeclarationName) names.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/**
 * The ORIGINAL name behind each imported binding, by local name.
 *
 * `import { DEFAULT_OPTIONS as KEYS }` binds `KEYS` locally, so looking the constant
 * up by the local name finds nothing and `KEYS.INVENTED` sails through. The map keeps
 * both ends so the alias resolves back to what the package actually exports.
 *
 * @param source - The parsed snippet.
 * @returns Local binding name to the exported name it stands for.
 */
function importedAliases(source) {
  const aliases = new Map()
  const visit = (node) => {
    if (ts.isImportSpecifier(node) && ts.isIdentifier(node.name)) {
      aliases.set(node.name.text, node.propertyName?.text ?? node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return aliases
}

/**
 * The names a snippet IMPORTS, as opposed to the ones it declares itself.
 *
 * The distinction decides whether `DEFAULT_OPTIONS.SOMETHING` is checked against the
 * package's constant: an import means it IS that constant, while a local `const` of the
 * same name means the snippet's own object and must be left alone.
 *
 * @param source - The parsed snippet.
 * @returns The set of imported binding names.
 */
function importedIn(source) {
  const names = new Set()
  const visit = (node) => {
    if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) {
      if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

/** `OBJECT.KEY` reads, so a key that the real constant does not define can be caught. */
function constantReads(source) {
  const reads = []
  const visit = (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isIdentifier(node.name)
    ) {
      reads.push({ object: node.expression.text, key: node.name.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return reads
}

/** The member and parameter-property names one class declares. */
function membersOf(node) {
  const names = new Set()
  for (const member of node.members) {
    if (member.name && ts.isIdentifier(member.name)) names.add(member.name.text)
    // Parameter properties: `constructor(private readonly service: X)`.
    if (ts.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        if (parameter.modifiers?.length && ts.isIdentifier(parameter.name)) {
          names.add(parameter.name.text)
        }
      }
    }
  }
  return names
}

/**
 * The `this.x` reads that no class in the snippet declares, checked ONE CLASS AT A
 * TIME.
 *
 * Merging every class into a single set was the earlier shape, and it let a second
 * class cover for the first: `class A { f() { this.missing() } } class B { missing() {} }`
 * passed because `B` contributed the name. `this` inside `A` cannot reach `B`.
 *
 * A nested class is walked as its own scope and does not lend its members to the
 * class enclosing it, for the same reason.
 *
 * @param source - The parsed snippet.
 * @returns The undefined member names, and whether any class was seen at all.
 */
function undefinedThisMembers(source) {
  const missing = new Set()
  let sawClass = false

  /** Collect `this.x` reads in this class, skipping any nested class's own scope. */
  const readsIn = (node, into) => {
    ts.forEachChild(node, (child) => {
      if (ts.isClassDeclaration(child) || ts.isClassExpression(child)) return
      if (
        ts.isPropertyAccessExpression(child) &&
        child.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isIdentifier(child.name)
      ) {
        into.add(child.name.text)
      }
      readsIn(child, into)
    })
  }

  const visit = (node) => {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      sawClass = true
      const declared = membersOf(node)
      const used = new Set()
      readsIn(node, used)
      for (const name of used) {
        if (!declared.has(name)) missing.add(name)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { missing, sawClass }
}

const symbols = internalSymbols()
const constants = constantMembers()
const findings = []
/** `file::symbol` for every finding, so the baseline survives line shifts. */
const keys = new Set()

for (const file of walk(DOCS, (f) => extname(f) === '.md')) {
  const markdown = readFileSync(file, 'utf8')
  let blocks
  try {
    blocks = snippetsOf(markdown)
  } catch (error) {
    // Name the file: the extractor knows the line, not which document it came from.
    console.error(`${file.slice(ROOT.length)}: ${error.message}`)
    process.exit(1)
  }
  for (const { line, code } of blocks) {
    // The name is a LABEL, not a path — `createSourceFile` parses the string it is
    // given and never touches the filesystem, so no snippet is written to disk.
    const source = ts.createSourceFile(`${file}:${line}.ts`, code, ts.ScriptTarget.Latest, true)
    const declared = declaredIn(source)
    const imported = importedIn(source)
    const aliases = importedAliases(source)
    const relative = file.slice(ROOT.length)

    for (const name of usedIn(source)) {
      if (symbols.has(name) && !declared.has(name)) {
        findings.push({
          key: `${relative}::${name}`,
          text: `${relative}:${line} — uses \`${name}\` without importing or declaring it`
        })
      }
    }

    for (const { object, key } of constantReads(source)) {
      // A snippet that declares the name ITSELF means its own object, not the
      // package's — checking a local `const options = {...}` against a same-named
      // constant in `src/` would report every one of its own keys as undefined. An
      // IMPORT is the opposite case: it says this IS the package's constant, which is
      // precisely when the key must be checked.
      if (declared.has(object) && !imported.has(object)) continue
      // Resolve through the alias: the constant is keyed by its EXPORTED name.
      const known = constants.get(aliases.get(object) ?? object)
      if (known && !known.has(key)) {
        findings.push({
          key: `${relative}::${object}.${key}`,
          text: `${relative}:${line} — reads \`${object}.${key}\`, which that constant does not define`
        })
      }
    }

    const { missing, sawClass } = undefinedThisMembers(source)
    if (sawClass) {
      for (const member of missing) {
        findings.push({
          key: `${relative}::this.${member}`,
          text: `${relative}:${line} — calls \`this.${member}\`, which its own class does not declare`
        })
      }
    }
  }
}

for (const finding of findings) keys.add(finding.key)

const baselinePath = join(ROOT, 'scripts', 'doc-snippets-baseline.json')

let baseline = []
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
} catch {
  // Absent baseline is only tolerable when adopting one for the first time.
  if (!process.argv.includes('--adopt-new')) {
    console.error(`Missing or unreadable baseline: ${baselinePath}`)
    console.error('Adopt one with: node scripts/check-doc-snippets.mjs --adopt-new')
    process.exit(1)
  }
}

if (process.argv.includes('--write-baseline')) {
  // Writes the INTERSECTION, never the current findings: regenerating from whatever
  // is failing right now would quietly adopt a defect introduced in the same edit,
  // which is the one way a shrink-only baseline can be made to grow.
  const kept = baseline.filter((key) => keys.has(key))
  writeFileSync(baselinePath, `${JSON.stringify(kept.sort(), null, 2)}\n`)
  console.log(`Baseline rewritten: ${baseline.length} → ${kept.length} known findings.`)
  process.exit(0)
}

if (process.argv.includes('--adopt-new')) {
  // The deliberate exception: widening what the check LOOKS AT (a new fence label, a
  // new question) surfaces pre-existing findings that were never anyone's regression.
  // Adopting them is a decision to make on purpose and to state in the commit, which
  // is why it is a separate flag and not what the routine command silently does.
  const adopted = [...keys].sort()
  writeFileSync(baselinePath, `${JSON.stringify(adopted, null, 2)}\n`)
  console.log(`Baseline adopted: ${baseline.length} → ${adopted.length} known findings.`)
  process.exit(0)
}

const known = new Set(baseline)
const introduced = findings.filter((finding) => !known.has(finding.key))
const fixed = baseline.filter((key) => !keys.has(key))

if (introduced.length > 0) {
  console.error(
    `Documentation snippets reference symbols that are not there (${introduced.length}):\n`
  )
  for (const finding of introduced.map((f) => f.text).sort()) console.error(`  ${finding}`)
  console.error('\nAdd the import, declare the symbol, or show the member the snippet calls.')
  process.exit(1)
}

if (fixed.length > 0) {
  console.error(`The baseline lists ${fixed.length} finding(s) that no longer reproduce:\n`)
  for (const key of fixed.sort()) console.error(`  ${key}`)
  console.error('\nThey were fixed — drop them so the baseline keeps shrinking:')
  console.error('  node scripts/check-doc-snippets.mjs --write-baseline')
  process.exit(1)
}

console.log(
  `✔ No documentation snippet references a missing symbol (${known.size} pre-existing, none new).`
)
