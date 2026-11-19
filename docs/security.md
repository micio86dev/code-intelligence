# Security model

`code-intel` is meant to be run by developers and by AI agents, often inside repositories they did not write. That shapes the threat model.

## Assumptions

- **The repository under scan is untrusted.** Its files, `.code-intel.json`, `sgconfig.yml` rules and test scripts may be hostile.
- **The user's machine and installed engines are trusted.** We cannot defend against a compromised `semgrep` binary.

## What we do about it

| Risk                                                      | Mitigation                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shell injection through file names, refs or config values | Every child process is started with an **argv array and `shell: false`**. Tested with `$(...)`, backticks and pipes (`test/unit/exec.test.ts`). File names starting with `-` are prefixed `./`. `--since` refs starting with `-` are rejected and refs are verified with `git rev-parse --verify`.           |
| Config values becoming engine flags or remote rules       | The config has no free-form argument field. Semgrep configs must be registry ids (`p/…`, `r/…`) or repo-relative paths; **URLs and leading `-` are rejected**. Paths must be repo-relative with no `..`.                                                                                                     |
| Regex denial of service from hostile globs                | Glob complexity is capped (200 chars, ≤3 `**`, ≤12 wildcards) and repeated `**/` are collapsed. Found by scanning this repository with itself; regression-tested.                                                                                                                                            |
| Leaking secrets through our own output                    | gitleaks runs with `--redact`; findings carry rule id, location and description but **never the matched text**. Fingerprints hash the source line and are one-way. Tests assert a planted key appears in none of text/JSON/SARIF output, stderr, or the cache. Engine failure messages never include stdout. |
| Runaway or hanging engines                                | Per-engine timeout; the whole process group is killed; output is capped at 64 MiB. A timeout is `exit 3`, never a pass.                                                                                                                                                                                      |
| Scanning outside the repository                           | Symlinks are skipped; paths are repo-relative; absolute local paths never appear in reports.                                                                                                                                                                                                                 |
| Leftover files                                            | gitleaks input is staged in a temp directory (hard links where possible) removed in a `finally`. `mutate` removes `reports/` and `.stryker-tmp` it created.                                                                                                                                                  |
| Cache poisoning / stale results                           | Exact content-hash keys; engines backed by changing databases are not cacheable; writes are atomic renames; the cache directory is git-ignored.                                                                                                                                                              |

## What leaves your machine

`code-intel` itself makes no network requests. The engines it drives do, as documented by their projects:

| Engine           | Network use                                                                 | Notes                                                                                                    |
| ---------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| gitleaks         | none                                                                        |                                                                                                          |
| semgrep          | downloads rulesets when a config is a registry id (`p/default`)             | We pass `--metrics=off` and `--disable-version-check`. Use repo-local rule files for fully offline scans |
| osv-scanner      | queries the OSV API with the package names and versions from your lockfiles | **No source code is sent.** The tool also has `--offline` modes; we do not expose them yet (see ROADMAP) |
| trivy (fallback) | downloads its vulnerability database on first use and updates               | We pass `--skip-version-check`                                                                           |
| ast-grep         | none                                                                        |                                                                                                          |
| StrykerJS        | none by our invocation                                                      | We enable only the JSON reporter, never the dashboard                                                    |

If your policy forbids sending dependency lists to a third party, do not run the `deps` category (`-e secrets,sast`) or use an engine mode you control.

## What is stored on disk

`.code-intel/baseline.json` (fingerprint hashes, engine, rule id, path), `.code-intel/cache/` (findings without secrets; git-ignored). Nothing else, and nothing outside the repository.

## Known limits

- A malicious _engine_ or a malicious Stryker config/test script runs with your privileges; `mutate` executes the project's own test command by design. Do not run `mutate` on code you would not run tests for.
- Findings are only as good as the engines' rules. A clean report means "these checks found nothing", not "this code is safe".

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md).
