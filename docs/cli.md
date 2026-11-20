# CLI reference

```
code-intel <command> [options]
```

Global options: `-h, --help`, `-v, --version`, `--log-level silent|error|warn|info|debug` (default `warn`), `--log-format text|json`. Logs go to **stderr**; results go to **stdout**.

Exit codes: `0` ok · `1` findings at/above threshold · `2` usage/config error · `3` incomplete · `70` internal error.

## scan

```
code-intel scan [scope] [options]
```

Scope (default `--changed` inside a git repo, `--all` otherwise):

| Flag            | Meaning                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| `--changed`     | Uncommitted changes versus `HEAD`, plus untracked files                               |
| `--staged`      | Only the index                                                                        |
| `--since <ref>` | Working tree versus a ref (`main`, `HEAD~3`, a SHA). Option-looking refs are rejected |
| `--all`         | Tracked + untracked, non-ignored files                                                |

Options:

| Flag                                          | Meaning                                                                                                                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-p, --profile quick\|deep`                   | See README. Default `quick`                                                                                                                                                                                                   |
| `-e, --engines a,b`                           | Categories (`secrets`, `sast`, `deps`, `architecture`) and/or engines (`gitleaks`, `semgrep`, `osv-scanner`, `trivy`, `ast-grep`)                                                                                             |
| `-f, --format text\|json\|sarif`              | Default `text`                                                                                                                                                                                                                |
| `--new-only`                                  | Hide findings present in the baseline                                                                                                                                                                                         |
| `--fail-on info\|low\|medium\|high\|critical` | Default `high` (or config)                                                                                                                                                                                                    |
| `--timeout <ms>`                              | Per-engine limit, minimum 1000                                                                                                                                                                                                |
| `--allow-missing`                             | A missing engine no longer makes the scan incomplete                                                                                                                                                                          |
| `--no-cache`                                  | Neither read nor write cached results                                                                                                                                                                                         |
| `--ignore-repo-config`                        | Discard the repository's own `.code-intel.json`, `.gitleaks.toml`, `.gitleaksignore` and baseline. Use it on code you do not control: a repository can configure a scan to find nothing. Cannot be combined with `--new-only` |

## impact

```
code-intel impact [--changed | --staged | --since <ref>] [--json]
```

Lists tests affected by the change. With a CodeGraph index (`codegraph init` once) the index is synced and `codegraph affected` answers transitively (`method: "codegraph"`). Otherwise a heuristic lists tests that directly import a changed module or share its name (`method: "heuristic"`) and states that transitive dependents are not detected. `--all` is rejected.

## mutate

```
code-intel mutate [files...] [--changed | --staged | --since <ref>] [--min-score <0-100>] [--timeout <ms>] [--json]
```

Mutation-tests JavaScript/TypeScript with StrykerJS, which must be a dev dependency of the project (`npm i -D @stryker-mutator/core`). Without file arguments only the **changed lines** are mutated. The project's `stryker.config.*` is used when present; otherwise the `test` script in `package.json` is run via Stryker's command runner. Keep that script to tests only: linters in `npm test` make every mutant look "killed".

Output reports per-file score, survivors (line, mutator, replacement) and totals. A survivor is a behavior change your tests did not notice. Exit `1` if `--min-score` is not met, `3` if the run did not complete (no Stryker, failing baseline tests, timeout). Reports and temp directories Stryker creates are removed afterwards unless they existed before. Other languages are listed under `skippedFiles`.

## baseline

```
code-intel baseline [-p profile] [-e engines]
```

Runs a full (`--all`) scan and writes fingerprints to `.code-intel/baseline.json` (configurable). Refuses to write if the scan was incomplete. The file contains hashes, rule ids and paths only and is meant to be committed.

## doctor

```
code-intel doctor [--json]
```

Reports git, repository state, config validity, each engine's availability/version with install hints, and optional tools. Exits 2 if the config is invalid.

## init

Creates `.code-intel.json` (minimal, with `$schema`). Never overwrites, never follows a symlink: exits 2 if the config exists (a dangling symlink counts as existing).
