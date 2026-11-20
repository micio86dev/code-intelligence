# Performance considerations

Measured numbers live in [benchmarks.md](benchmarks.md) (generated from `bench/results/`; nothing here is a hand-typed figure). This page explains _why_ the tool is shaped the way it is and what to do when a scan is slower than you want.

## What the tool does to stay fast

- **It scans what you changed.** The default scope is the working-tree diff plus untracked files. A one-file change costs one engine start-up, not a repository walk.
- **Engines run concurrently.** gitleaks, semgrep and osv-scanner are independent processes, so wall time approaches the slowest engine instead of the sum. The benefit shows up when two engines each take real time (for example osv-scanner's network round trip alongside semgrep).
- **It never spawns a tool just to ask its version before work starts.** Planning only locates binaries on `PATH`. Each engine's version is read _concurrently with its own run_. (Found by phase timing: asking semgrep for `--version` serially cost about half a second per scan, because it is a Python program.)
- **Semgrep keeps its own file selection.** With a directory target semgrep applies `.gitignore`, `.semgrepignore` and its default ignores (tests, vendored and minified code). Passing every file explicitly bypassed those, scanned more, and reported more noise.
- **SAST findings on untouched lines are filtered**, so a small change produces a small report.
- **Dependency scanning only runs when a lockfile or manifest is in scope** (otherwise the engine is reported `skipped` with the reason).
- **Hard time limits.** Every engine has a per-profile timeout; the process group is killed on expiry and the scan is reported incomplete (exit 3), never as a pass.
- **No daemon, no watcher, no index of its own.** Nothing runs between invocations.

## Where the time goes

For a typical change the cost is dominated by **semgrep's fixed start-up** (a couple of seconds, independent of how many files you changed) plus the OSV API round trip when a lockfile changed. Everything the tool adds on top (git calls, normalization, report) was measured at a few tens of milliseconds on the express repository (216 files): about 21 ms to resolve the target, 4 ms to normalize 45 findings, 20 ms to count inline suppressions, 0 ms to plan after the lazy-version fix. That is why scanning one changed file on a large repository is close to the cost of scanning one file on a small one; see the incremental table in [benchmarks.md](benchmarks.md).

## Profiles

|                  | `quick` (default)               | `deep`                          |
| ---------------- | ------------------------------- | ------------------------------- |
| Categories       | secrets, SAST, dependencies     | + architecture (ast-grep rules) |
| Per-engine limit | 60 s                            | 10 min                          |
| Use for          | after a change, before a commit | audits, `--all`, scheduled jobs |

`mutate` is separate because it is minutes, not seconds: it re-runs your tests once per mutant. It is scoped to **the lines you changed**, runs mutants in parallel, and should be used before merging risky logic or when test quality is the question, not after every edit.

## Result cache

Exact-match, stored in your user cache directory (`code-intel doctor` prints the path). Only engines whose output is a pure function of file contents are cached: gitleaks, and semgrep with **local** rules. Dependency scanners depend on a changing vulnerability database and semgrep registry rules change remotely, so they are never cached. With the default configuration the cache therefore saves little; use `--no-cache` to bypass it. Editing a rule file or `.gitleaks.toml` invalidates affected entries automatically, because their contents are part of the key.

## If a scan is slow

1. **Narrow the scope**: `--changed` (default), `--staged`, `--since <base>`. Avoid `--all` outside audits.
2. **Pick engines**: `-e secrets,sast` skips the OSV network call; `-e deps` is dependency-only.
3. **Use local semgrep rules** (`engines.semgrep.configs`): no registry download, works offline, and becomes cacheable.
4. **Exclude generated code**: `exclude` globs (bounded in count and cost; see [configuration.md](configuration.md)).
5. **Raise the limit only deliberately**: `--timeout <ms>`. A timeout means the check did not complete, so exit 3 is the correct answer until it does.
6. **Large monorepos**: the tool always works from the git root (running it in a subdirectory does not narrow the scope), so bound a large diff with `--since <merge-base>` and use `exclude` for generated trees.

## Memory

Memory is mostly the engines' own (semgrep is the largest process). The tool itself holds file lists and findings. Peak resident size per scenario is in [benchmarks.md](benchmarks.md), reported as the largest single process, not a sum.
