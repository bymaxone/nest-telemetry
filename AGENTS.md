# @bymax-one/nest-telemetry — Agent Specification

> **Prerequisite:** Read [CLAUDE.md](./CLAUDE.md) first for critical rules. This file extends it with architecture and patterns — load on demand, not every session.

---

Orientation (what the package is, how it is built and published) lives in
[docs/README.md](./docs/README.md). It is not a rule, and it is kept out of this file because every
byte here is charged against the reviewer's instruction budget. Codex does not follow that link —
nothing normative belongs behind it.

## 3. Design Principles

- **The library is the mechanism; the host application is the policy.** Service name, sampling,
  endpoints, probe-path filtering and which instrumentations run are options of the host, with safe
  defaults. The library never reads them from anywhere but the one documented environment boundary.
- **Every `@opentelemetry/*` package is an optional peer.** A boot that is disabled loads none of them.
  `pnpm check:runtime` proves it from the packed tarball, in ESM and in CommonJS.
- **The SDK part does not require Nest.** The `.` entry and `./register` import no `@nestjs/*` package;
  only `./nest` does. `pnpm check:runtime` loads `.` in plain Node with no `@nestjs/*` installed.
- **Environment reads happen in one place.** No other module touches `process.env`.

## 4. Security Specification

- Redaction of `url.query` and `url.full`, and of Redis command payloads, is ON by default and
  cannot be turned off silently: disabling it is an explicit option that is reported at boot.
- Redaction is applied by a span processor on span end, so it covers spans created by any
  instrumentation, not only those the library configures.
- A failure in the telemetry path (exporter down, flush timeout) never crashes or blocks the host.

## 5. Testing Strategy

**100% statements / branches / functions / lines — unit and e2e, no exclusions.** Enforced by
`jest.config.ts` (`pnpm test:cov`), `jest.e2e.config.ts` (`pnpm test:e2e`) and
`jest.coverage.config.ts` (`pnpm test:cov:all`, unit and e2e together). `passWithNoTests` is off in
all of them. Stryker (`break: 100`) is the deeper gate against weak tests, and the mutation
inventory gate runs in `enforce` mode.

A unit spec opens no socket and starts no server (`pnpm check:socket-gate`); a spec that needs an
OTLP receiver or a child process lives in `test/e2e`. The `--import` preload cannot be loaded by Jest
as a real preload, so its logic sits in a function that a unit spec reaches through
`jest.isolateModules`, and `test/e2e` spawns a real `node --import` process to prove the ordering.

An equivalent mutant is documented in the source as
`// Stryker disable next-line <Mutator>: <reason>` and enforced by `pnpm check:mutants`; a reason
after `--` or on a second line is silently dropped.

## 6. Packaging invariants

`exports` declares `types` **per condition** — `import` -> `.d.ts`, `require` -> `.d.cts`. A single
shared `types` key makes CommonJS consumers resolve ESM declarations, because `"type": "module"`
marks plain `.d.ts` as ESM.

Subpaths also need a `typesVersions` entry: the `moduleResolution: node` algorithm predates
`exports` and ignores it. `pnpm check:exports` runs the strict `attw` profile, which covers that
mode — never weaken it with `--profile` to silence a row.

Each subpath is a separate bundle, so a module reached from two of them by a relative path is
copied into each, and a copied class is a different injection token. `pnpm check:runtime` boots the
packed tarball to catch it.

## 7. Common Pitfalls

- Importing an `@opentelemetry/*` package at module top level in code a disabled boot reaches: load it lazily.
- Reading `process.env` outside the one environment boundary.
- String injection tokens or a missing `@Inject(TOKEN)`: `Symbol()` only, always explicit `@Inject`.
- `any`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable` or a coverage-ignore comment: fix the cause.
- Cross-subpath import that makes `.` depend on `./nest`: `.` never imports Nest.

---

## 8. Pre-Task Checklist

Before starting: read CLAUDE.md. Before finishing:

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` — all pass
- [ ] Barrel export updated if new public API was added
- [ ] JSDoc on new public exports, all text in English, `@Inject(TOKEN)` on every new provider

---

## 10. Code Review Rules

<!-- shared:begin -->
<!--
  CANONICAL COPY: bymaxone/.github → agents/code-review-rules.md
  Do not edit this block in a consuming repository. It is replaced wholesale by
  the `agents-sync` reusable workflow, so a local edit is reverted on the next
  run. Change it here, cut a release, and every repository is offered the update.

  Repository-specific rules go OUTSIDE this block, below the closing marker.
  Editing notes: AGENTS.md in bymaxone/.github.
-->

These rules hold in every Bymax repository. What is specific to this one is written after this
block, and the two are read together.

The pipeline already enforces formatting, linting, dependency policy, coverage and — where the
repository has one — the mutation gate. Do not spend a review on a **violation** of one of those: it
is a red check, not a comment. What follows is what CI cannot see.

A violation of a rule in this block is reported at **P1** at minimum. Codex surfaces only P0 and P1
on a pull request, so a rule whose violations land at P2 is a rule nobody sees.

**When a rule moves from here into a check, it leaves here.** A red check is proportionate to a
correctness failure that is invisible without it, and disproportionate to style enforced at an
inconvenient moment. Never carry both: a rule stated here _and_ enforced by CI spends a reviewer's
attention on what a gate already reports.

**A change to the enforcing configuration is the opposite case, and it is in scope.** Every gate runs
the configuration from the branch under review — that branch's lint config, its coverage thresholds,
its mutation thresholds. So a pull request that deletes a rule, lowers a threshold or widens an
ignore glob turns the check **green**, because a gate reports on the rules it was handed. For those
diffs the review is the only independent check there is, and a weakened gate needs the same
justification a suppression does.

### A finding names what it read

Every factual claim in a review — about a library's API, about this repository's history, about what
a file contains — has to come from something read in the tree under review, and the finding should
say which. A claim assembled from recollection is likely to describe a previous version of whatever
it is about.

**Safe path**, by the kind of claim:

| Claim about                             | Read this                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| A library's API **shape**               | `node_modules/<pkg>/dist/**/*.d.ts` in this tree                               |
| A library's **runtime behaviour**       | that version's changelog entry, its documentation, or a test that exercises it |
| A commit's author or committer identity | out of scope: it is not text a change introduces                               |
| What a file contains                    | the file at the revision under review, not an earlier one                      |

The first two rows are separate on purpose: a `.d.ts` settles what a signature accepts and nothing
about what the implementation does with it, so a behavioural claim resting on one is unfounded.

Weight the checking by what acting on the finding would cost. A comment that asks for a reworded
sentence is cheap to be wrong about; one that asks for history to be rewritten, a merge reverted, or
a release pulled is not — verify that class before raising it, and raise it at the severity the
evidence supports rather than the severity the consequence would deserve if true.

### A bug reproduces, and a finding is this change's

Unless a rule here says to report without one, raise a bug only with its trigger: the input or
repository state, the command, the wrong result. Letting through what should be refused is P1 at
least, as is a crash an untrusted caller can trigger; a refusal, or a crash no untrusted caller can
reach, on input the project does not claim to support is not. Behaviour already present at the merge
base belongs to another change. On new commits, review what changed since the last reviewed commit.
A thread is settled only when the reply cites evidence that disproves the finding (a command, a
test, a file:line) or the code it names changed; a resolved thread or a bare reason is not evidence,
so re-check the current code and raise the finding again only if its trigger still reproduces. One
comment per root cause, its siblings named in it.

### A dependency upgrade migrates every call site, not only the ones that fail to compile

When an upgrade tightens a contract, the compiler catches only the call sites whose **shape**
changed. A field that stays optional in the published type while becoming mandatory in behaviour
compiles, passes the unit suite, and fails in production.

A `@bymax-one/*` version number carries **no compatibility information** while the libraries are
pre-stable: breaking changes ship in minor and patch releases by explicit policy, so `^` and `~`
protect against nothing. The migration note under **Apply to a derived backend** in the library's own
changelog is the compatibility contract.

**Safe path:** read **every** changelog entry from the version being replaced up to the proposed
one, not only the proposed one's, and check every call site they name — not only the ones the
compiler rejected. Upgrades routinely skip releases, and the entry that matters is often not the
last one: adopting `@bymax-one/nest-cache` 1.1.0 → 1.2.1 skipped 1.2.0, whose entry holds a security
fix. Diff the `.d.ts` of the **previously adopted** version against the **proposed** one — `npm
pack` both, and name the two versions. Reaching for "the installed declarations" is the trap: in a
checkout of the branch under review the installed tree is already the new version, so that diff
compares a release with itself and shows nothing.

### Settled decisions are not review findings

Both are settled deliberately, and reopening either costs a round trip and changes nothing:

- **Do not propose a major version bump** for a breaking change in a `@bymax-one/*` library, and do
  not assert that this ecosystem follows strict SemVer. Until an API is declared stable, breaking
  changes ship in minor and patch releases; the migration note carries the compatibility information
  the number does not. If a document claims strict SemVer, the finding is that the claim is wrong —
  not that the version should be raised.
- **Do not propose pinning `bymaxone/.github` reusable workflows to a commit SHA.** They are
  referenced by the `@v1` alias on purpose: a fix has to land once and reach every repository, the
  tag is immutable and the alias moves only on a release, and pinning was measured to cost ~58
  dependency pull requests to propagate one change. Third-party actions are the opposite case and
  **are** pinned by SHA.

**Safe path:** if you believe a settled decision is now wrong, say so as a question in the pull
request rather than as a finding.

### Suppressions are refusals, not exceptions

`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable` in any form,
`as unknown as` laundering a real type error, `istanbul ignore`, and in Rust `#[allow(...)]` over a
lint gate or `unsafe` without a `// SAFETY:` comment are blocking findings.

Anything a configured gate already reports belongs to the gate, not to a review: where a repository
lints `no-explicit-any` as an error — most do — an `as any` is a red check, and raising it here only
duplicates it. Check the repository's lint configuration before reporting a suppression rather than
assuming the list is exhaustive in either direction.

A failing gate means the code is wrong, the type is wrong, or the rule is wrong. **Safe path:** fix
whichever it is. Changing a rule's configuration with a stated reason is legitimate; scattering
per-call-site silencers is not.

### A key built from more than one field keeps its boundaries

A key or digest derived from **two or more variable fields** must not let a field's content move the
boundary between them. `${tenantId}:${recipient}` makes `('a:b','c')` and `('a','b:c')` one key,
which no digest strength repairs, and one tenant's lookup then resolves another's record. Rejecting
empty fields does not fix it, and neither does a caller that validates its input — the property has
to hold in the construction. A fixed prefix beside a single field is not this shape.

**Safe path:** encode each field so it cannot contain the delimiter, or hash each to a fixed width.
Any other composition needs an argument that every boundary is recoverable, and one bounded field
does not rescue two free ones beside it. Then assert it in a test: where the property holds only
because of the values in play, the next one added takes it away and nothing says so.

### Comments state constraints, never history

A comment must read as true for whoever opens the file next. Flag any comment that narrates what a
previous version did, names a phase, task, ticket or review round, or explains a change rather than
the code. **Safe path:** state the constraint that still holds, and let `git log` carry the history.

Evidence for a constraint is not history, and how the evidence was obtained does not decide which it
is. The test is whether the fact still binds the next reader. A measurement that predicts what they
will hit on the other path — what the alternative did, what it costs in numbers — belongs beside the
constraint it supports, however it was obtained. What ages is the part that cannot recur for them:
what a previous version of this code did, a version number, a registry state, a review round, a
failure that has since been fixed. Flag those; keep the measurement.

### Size and layering

Functions over **50 lines** and nesting deeper than four levels are findings **for what a change
introduces** — a new function, or a change that pushes an existing one past the limit — in the
repository's own source and test directories. A test-suite grouping construct (`describe`, `context`,
`mod tests`, a table of cases) is not a function; the unit under the limit is the body of a single
`it`/`test`/`#[test]`. On the same terms, every non-trivial source file a change introduces opens
with a header stating its purpose and its layer, and every exported symbol a change introduces
carries a doc comment.

**The 800-line file limit applies to what a change introduces, not to what it inherits.** A
repository that already carries a file past the line — a generator, a long end-to-end suite — would
otherwise produce a finding on every pull request touching three lines of it, which the author
cannot act on and did not cause. Raise it for a **new** file over the limit, or when a change pushes
a file past it or materially grows one already over.

Markdown, generated output and lockfiles are **out of scope**: none has layers, and reporting their
length fires on every dependency bump and release note.

**Safe path:** extract by responsibility rather than by line count — the limit is a symptom, and one
file doing two jobs is the defect.

### Language and attribution

Everything published is English — source, comments, tests, commit messages, pull request titles and
bodies, `README.md`, `CHANGELOG.md` and everything under `.github/`.

Each repository states its language policy for `docs/` below this block. Report a language finding in
`docs/` only against what the repository states; where it states nothing, `docs/` is English like
everything else. A `docs/` language other than English is a repository-owner decision recorded in the
narrowings, not a convention a contributor may introduce.

No commit, pull request, comment or code may attribute authorship to an AI assistant or coding tool,
in any form. **Only text the change introduces is in scope** — a trailer, a "generated with" line, a
signature in a comment or a description.

A commit's author and committer fields are not that: they come from the contributor's git
configuration rather than from the diff, and a review reading the diff cannot see them. Never report
an identity field, and never present a command's reconstructed output as evidence for one. Measured:
twenty-six such findings, every SHA resolving nowhere and every `git log` line unrun, each asking to
rewrite published history.

<!-- shared:end -->

## Session memory (Obsidian vault)

Lessons from earlier sessions live outside the repository, in the owner's Obsidian vault at `~/Documents/MyApps/obsidian/Brain/`, when it is present on this machine. Before a task, find this repository's hub under `02 - Areas/`: the table in `02 - Areas/Bymax/Bymax.md` maps each Bymax repository to its folder; for any other repository, search `02 - Areas/` for the repository name. Read the hub with its `Learnings.md` and `Decisions.md`, and the relevant stack notes under `03 - Resources/`. When the vault and the code disagree, the code wins. Record each non-obvious gotcha, root cause or decision in the hub as the vault's `_meta/conventions.md` describes; a repository without a hub gets one from `_meta/templates/project-hub.md`.
