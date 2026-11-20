# code-intelligence

A small CLI, `code-intel`, that gives AI coding agents (and humans) the one thing LLM review cannot: **deterministic evidence**. It runs mature open-source scanners on _what you changed_, normalizes their output into one stable format, and reports only what matters.

It works with any agent that can run a shell command (Claude Code, Codex, OpenCode, Pi, Gentle Shell, ...). It has no dependency on any of them.

```console
$ code-intel scan
code-intelligence 0.1.0 | profile quick | changed | 4 file(s), 0 excluded | 3.17s

Engines
  [FOUND  ] gitleaks 8.30.1        1 finding(s), 0.02s
  [FOUND  ] semgrep 1.186.0        1 finding(s), 2.20s
  [FOUND  ] osv-scanner 2.7.1      5 finding(s), 0.75s

Findings (6)
  HIGH     creds.txt:1  [gitleaks +semgrep] aws-access-token
           Identified a pattern that may indicate AWS credentials, risking unauthorized cloud resource access and data breaches on AWS platforms.
           fix: Revoke and rotate this credential now, remove it from the code and git history, and load it from a secret manager or environment variable.
  HIGH     package-lock.json  [osv-scanner] GHSA-35jh-r3h4-6jhm
           lodash@4.17.15 (npm) is affected by GHSA-35jh-r3h4-6jhm (CVE-2021-23337): Command Injection in lodash
           fix: Upgrade lodash to 4.17.21 or later.
  ...4 more findings omitted here...

Summary: 4 high, 2 medium
Result: FAIL (exit 1): findings at or above 'high'.
```

(Captured output of a scan of a throwaway project containing a fake AWS key and a lockfile pinning lodash 4.17.15. Four of the six findings are omitted for length, which the `...` line marks; nothing shown was edited. Note `[gitleaks +semgrep]`: both engines found the same key and it is reported once.)

## The problem

Agent workflows today verify code with _another LLM_. That is useful, but it cannot tell you "this lockfile pins a package with a published CVE", "this string is a live AWS key", or "your tests would not notice if `>=` became `>`". Those are facts, and tools already exist to establish them. They are just slow to run everywhere, noisy, and each has its own output format.

`code-intel` makes them cheap and uniform:

| Question                                       | Command        | Engine (not bundled)                                                                              |
| ---------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| Did I just commit a secret?                    | `scan`         | [gitleaks](https://github.com/gitleaks/gitleaks)                                                  |
| Did I introduce an injection or unsafe call?   | `scan`         | [semgrep](https://semgrep.dev)                                                                    |
| Do my dependencies have known vulnerabilities? | `scan`         | [osv-scanner](https://github.com/google/osv-scanner), fallback [trivy](https://trivy.dev)         |
| Did I break a layer boundary (domain → infra)? | `scan -p deep` | [ast-grep](https://ast-grep.github.io) with _your_ rules                                          |
| Which tests does this change affect?           | `impact`       | [codegraph](https://github.com/colbymchenry/codegraph) (transitive), labelled heuristic otherwise |
| Would my tests notice a behavior change?       | `mutate`       | [StrykerJS](https://stryker-mutator.io) (JS/TS)                                                   |

## What it deliberately does not do

- **No LLM, no API key, no network service of its own.** Interpretation is the agent's job; this tool only supplies evidence.
- **No daemon, no MCP server, no hooks, no background process.** It runs, prints, exits.
- **No automatic full scans.** Nothing runs unless you (or your agent) call it. Default scope is the files you changed.
- **No orchestration, memory, skills, model selection or LLM code review.** Those are solved by your agent framework; see below.
- **No bundled scanners.** It drives the ones you install, and tells you precisely what is missing instead of pretending a check passed.
- **No rules of its own for architecture.** You write the ast-grep rules; we only run them.

## How it differs from agent frameworks

Gentle AI / Gentle Shell, Claude Code, Codex and friends decide _what to do and when_. `code-intel` answers _"what does the code actually contain?"_ with a command that has a stable interface and exit codes. It does not replace [Gentle AI or Gentle Shell](https://github.com/Gentleman-Programming): it plugs into them. For example, Gentle AI's `review-risk` lens asks for "concrete exploit or scanner evidence" but has no tool to get any; `code-intel scan --format json` is exactly that evidence. The companion repo [code-intelligence-skills](https://github.com/micio86dev/code-intelligence-skills) ships the skill that teaches each agent when to call it.

Likewise it does not duplicate [CodeGraph](https://github.com/colbymchenry/codegraph): `impact` calls `codegraph affected` rather than building its own graph.

## Install

Requires Node.js 22 or newer.

```bash
# From the npm registry:
npm install -g code-intelligence

# Or from a GitHub release (the same prebuilt tarball, no build step):
npm install -g https://github.com/micio86dev/code-intelligence/releases/download/v0.1.0/code-intelligence-0.1.0.tgz

# Or straight from the repository (builds on install):
npm install -g github:micio86dev/code-intelligence
```

(`0.1.0` was published to npm by hand from the release tarball, so it carries no provenance attestation yet; see [ROADMAP](ROADMAP.md).)

Then install the engines you want. `code-intel doctor` prints what is present and the exact command for what is missing:

```bash
brew install gitleaks semgrep osv-scanner ast-grep     # macOS / Linuxbrew
code-intel doctor
```

Nothing is installed automatically.

## Quick start

```bash
cd your-repo
code-intel doctor                    # which engines are available?
code-intel scan                      # changed files, quick profile
code-intel scan --staged             # only what is staged (pre-commit)
code-intel scan --since main         # everything on this branch
code-intel scan --all -p deep        # whole repo, adds architecture rules
code-intel scan --format json        # for agents and CI
code-intel scan --format sarif > results.sarif   # GitHub code scanning

code-intel impact                    # which tests does my change affect?
code-intel mutate                    # are my tests strong enough? (slow, JS/TS)

code-intel init                      # optional: write .code-intel.json
code-intel baseline                  # accept today's findings...
code-intel scan --new-only           # ...and only fail on new ones
```

### Exit codes

| Code | Meaning                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------- |
| 0    | Complete scan, nothing at or above `--fail-on` (default `high`)                                   |
| 1    | Findings at or above `--fail-on`                                                                  |
| 2    | Usage or configuration error                                                                      |
| 3    | **Incomplete**: no blocking findings, but an engine timed out, crashed or is missing. Not a pass. |

A missing scanner is reported as `unavailable` and yields exit 3. A check is never silently skipped and counted as success. Pass `--allow-missing` if you really want it downgraded.

## Using it from several agents

The CLI is the same everywhere; only the one-time wiring differs. [code-intelligence-skills](https://github.com/micio86dev/code-intelligence-skills) provides a single canonical skill and installers for Gentle Shell, Claude Code, Codex, OpenCode and Pi. Any other agent that can run shell commands can use the CLI directly with `--format json`.

## Profiles

|                       | `quick` (default)   | `deep`         |
| --------------------- | ------------------- | -------------- |
| Categories            | secrets, sast, deps | + architecture |
| Time limit per engine | 60 s                | 10 min         |
| Typical scope         | changed files       | `--all`        |

`mutate` is a separate command because it is minutes, not seconds.

## Honest limitations

- `impact` is only transitive with a CodeGraph index (`codegraph init`). Without one it lists direct importers and name matches and _says so_.
- `mutate` supports JavaScript/TypeScript (StrykerJS). Other languages are listed as skipped, not ignored. See [ROADMAP](ROADMAP.md).
- SAST findings on lines you did not touch are hidden in changed-file scans (and the count is printed). Use `--all` to see them.
- `osv-scanner` and `semgrep` registry rulesets need network access. See [docs/security.md](docs/security.md) for exactly what leaves your machine.
- Result caching only applies to engines whose output is a pure function of file contents (gitleaks; semgrep with local rules). With default settings the gain is small. See [docs/performance.md](docs/performance.md).
- Changed-file scans do not descend into git **submodules** (a nested repository carries its own configuration, which would be executable surface); scan the submodule's own repository.
- A repository can configure a scan to find less. Every report lists what the repository supplied (`config.inEffect`), and `--ignore-repo-config` discards it. Inline `gitleaks:allow` / `nosemgrep` comments cannot be disabled; they are counted and disclosed.

## Disable or remove

```bash
npm uninstall -g code-intelligence
rm -rf .code-intel .code-intel.json     # per-project config and baseline (optional)
rm -rf "$(code-intel doctor --json | jq -r .cacheDir | sed "s#^~#$HOME#")"   # this repository's result cache (optional)
```

It writes only your optional `.code-intel.json` and `.code-intel/baseline.json` (if you run `init` / `baseline`) inside a repository, a result cache in your user cache directory (`code-intel doctor` prints the path; safe to delete), and temporary directories that are removed after each run.

## Documentation

[Architecture](docs/architecture.md) · [CLI reference](docs/cli.md) · [Configuration](docs/configuration.md) · [Security model](docs/security.md) · [Performance](docs/performance.md) · [Benchmarks](docs/benchmarks.md) · [Troubleshooting](docs/troubleshooting.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md) · [Third-party notices](THIRD_PARTY.md)

## License

MIT. The scanners it drives keep their own licenses; see [THIRD_PARTY.md](THIRD_PARTY.md).
