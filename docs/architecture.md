# Architecture

`code-intel` is a pipeline of small, separately testable stages. Each stage is a plain function over plain data; there is no framework, no plugin loader, no daemon.

```
argv ──► main.ts (parseArgs, help, exit codes)
            │
            ▼
        commands/scan.ts ── config.ts (validate .code-intel.json, defaults)
            │
            ├─► targets.ts     git → changed | staged | since | all, minus excludes
            │                  + changed line ranges from `git diff -U0`
            ├─► planner.ts     category → first usable engine (priority order)
            │                  every category yields run | skip(reason) | unavailable(hint)
            ├─► runner.ts      engines run concurrently, each with a timeout;
            │                  one failure never hides another engine's result
            │      └─► engines/*.ts   adapters: build argv → exec → parse JSON → RawFinding[]
            ├─► normalize.ts   fingerprint, dedupe, changed-line filter, sort
            ├─► baseline.ts    optionally hide already-known fingerprints
            └─► report/{text,json,sarif}.ts
```

## Boundaries that matter

- **The core knows nothing about agents.** No agent names, paths or formats appear in `src/`. Agents integrate by running the CLI (see the separate `code-intelligence-skills` repository).
- **Engines are external binaries.** Adapters build an argv array and call `exec()`, which never uses a shell. An engine is a value implementing the `Engine` interface in `src/engines/engine.ts`; adding one is one file plus one line in `registry.ts`.
- **Adapters return `RawFinding`; the core owns identity.** Only `normalize.ts` computes fingerprints, so every engine gets the same stable identity rules.
- **Deterministic evidence vs. interpretation.** The CLI states facts with severity, location, explanation and remediation. Deciding what to do about them belongs to the caller.

## Data model

`Finding` (see `schema/report.schema.json`): `fingerprint`, `engine`, `ruleId`, `category`, `severity`, `file` (repo-relative POSIX), `line`/`endLine` (nullable), `message`, `remediation`, `references`. It never contains the matched source text or the secret itself.

`EngineResult.status` is one of `ok | findings | skipped | unavailable | timeout | error`. A scan is **complete** only if every planned engine ended `ok`, `findings` or `skipped` (or `unavailable` with `--allow-missing`). Exit code 3 reports an incomplete scan.

### Fingerprints

`sha256(engine, ruleId, file, normalized source line)[:16]`, or an explicit key for findings with no line (dependencies use `ecosystem:name@version#advisory`). Whitespace is collapsed, so reformatting and moving a line do not change identity; editing the line does. Baselines and `--new-only` rely on this.

## Selection rules

1. `--engines` (or the profile) lists categories and/or engine names.
2. For each category, engines are tried by priority. The first one that has work in scope _and_ is installed is chosen (`osv-scanner` before `trivy` for dependencies).
3. No work in scope → `skipped` with the reason (for example "no lockfile or manifest in scope"). Work but no installed engine → `unavailable` with install hints. A category with no engine at all → `skipped: no engine implemented`.

## Duplicates across engines

The same hardcoded secret is often found by both gitleaks and semgrep's `*.secrets.*` rules. Findings in the `secrets` category at the same file and line are merged into one (the dedicated scanner, gitleaks, wins; the highest severity is kept) and the other engine is credited in `alsoReportedBy`. Findings of other categories are never merged across engines.

## How semgrep is invoked

Semgrep's own file discovery applies `.gitignore`, `.semgrepignore` and its default ignores (tests, vendored and minified code). Passing explicit file paths bypasses all of that, which made an early version noisier than semgrep run by hand (27 extra findings from `test/` on one benchmark repository). So `--all` hands semgrep the directory plus our `exclude` globs, and changed-file scans use root-anchored `--include /path` patterns (an unanchored `index.js` would also match every nested `index.js`). Changed source files that semgrep still skipped are named in a warning rather than hidden.

## Paths

Engines disagree on symlink resolution (macOS `/var` vs `/private/var`): git may report one form and an engine the other. Child processes get a `$PWD` that matches their working directory, and every engine path is resolved against the repository root both as written and symlink-resolved. A path that still falls outside the repository is replaced by `<outside-repository>/<name>`, so local absolute paths never appear in a report.

## Changed-line filtering

In `changed`, `staged` and `since` modes, SAST findings on lines the change did not touch are dropped _and counted_ in `summary.suppressed.outsideChangedLines`. Secrets and dependency findings are never filtered, and files with no diff entry (untracked) count as wholly changed.

## Process handling

`exec()` spawns with `shell: false`, kills the entire process group on timeout, caps captured output (default 64 MiB) and reports spawn failures as data. Engine failures become typed `EngineFailure`s whose messages include the exit code and first line of stderr but never stdout, which may contain source code.

## Caching

One file per result in the **user's cache directory, never the repository** (`~/Library/Caches/code-intelligence/<repo-hash>` on macOS, `$XDG_CACHE_HOME` or `~/.cache` on Linux, `%LOCALAPPDATA%` on Windows; `CODE_INTEL_CACHE_DIR` overrides it, and `code-intel doctor` prints it). A cache inside a scanned repository would be attacker-controlled, because the key is predictable, so the repository's `.code-intel/cache` is never read or written. Exact match only: the key covers the tool version, the repository's real path, engine binary identity, config inputs (including the contents of config and local rule files) and the content hash of every input file. Entries are schema-validated on read. Engines opt in via `cacheable()` and only when their output is a pure function of those inputs, which excludes anything backed by a changing vulnerability database or remote ruleset.
