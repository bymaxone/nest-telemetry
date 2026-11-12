# Mutation Testing Results

> **Last run:** 2026-11-12, `pnpm mutation:full` semantics: cold, with no incremental baseline, run by the `Mutation (full)` workflow on `main` at `a590d9b`
> **Command:** Stryker 9, jest runner, `coverageAnalysis: perTest`, `ignoreStatic: true`, TypeScript checker
> **Report:** `reports/mutation/mutation.html`

## Summary

| Metric                                                   | Value                        |
| -------------------------------------------------------- | ---------------------------- |
| **Global mutation score**                                | **100.00 %**                 |
| Break threshold (`thresholds.break`)                     | 100 % → **PASS (exit 0)** ✅ |
| Aspirational target (`thresholds.high`)                  | 100 % → **reached**          |
| Mutants generated, in 10 source files                    | 463                          |
| Killed                                                   | 239                          |
| Survived                                                 | **0**                        |
| Timeout (counts as detected)                             | 0                            |
| No coverage                                              | **0**                        |
| Ignored: static mutants (`ignoreStatic: true`)           | 81                           |
| Ignored: a `// Stryker disable` comment                  | 0                            |
| Rejected by the TypeScript checker (they do not compile) | 143                          |

Score = `(killed + timeout) / (killed + timeout + survived)` = `239 / 239 = 100.00 %`.

The workflow then runs the inventory gate in `enforce` mode: every unit test must have run in the
mutation run.
The one exempt spec reads the text of the source files to check which of them names `process.env`;
it imports nothing from `src/`, so it executes no mutated code and judges no mutant. The reason is
recorded next to the file name in `scripts/mutation-inventory.exempt.json`.

## What the number means

Line coverage proves a line _executed_ under test; mutation testing proves a test _would fail_ if
that line were wrong. A mutant is a small change to the source (a flipped condition, a removed
call, a swapped literal). It is **killed** when a test fails because of it, and it **survives** when
the whole suite still passes.

- **Static mutants** are changes to code that runs once at module load, such as a constant table.
  Stryker cannot attribute a test to them without re-running the entire suite per mutant, so they
  are ignored. `ignoreStatic` is on, and the 81 of them are counted above rather than hidden.
- **Compile errors** are mutants the TypeScript checker rejects. They cannot run, so they are
  excluded from the score, which is why the checker is enabled: a change that does not compile is not
  evidence about the tests.
- **No suppression comments.** The run has no `// Stryker disable` comment, so every mutant outside
  the two groups above was judged by a test. A suppression, if one is ever added, must name its
  reason on the same line, and `pnpm check:mutants` enforces that grammar.

## Reproducing the run

```bash
pnpm mutation:full   # deletes the incremental baseline, then runs Stryker cold
pnpm mutation        # the incremental run used on every push
```

`stryker.config.json` sets `incremental: true`, so the per-push run re-tests only what changed. An
incremental run reuses stored verdicts, and reused verdicts for static mutants can be stale, which is
why the score is re-measured cold by the weekly `Mutation (full)` workflow.
