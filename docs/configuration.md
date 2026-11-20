# Configuration reference

Optional file `.code-intel.json` at the repository root. Everything has a default; `code-intel init` writes a minimal one. A JSON Schema ships in `schema/config.schema.json` for editor completion. Unknown keys and wrong types are errors (exit 2) with the exact path, for example `profiles.quick.timeoutMs: must be an integer between 1000 and 3600000`.

```json
{
  "$schema": "https://raw.githubusercontent.com/micio86dev/code-intelligence/main/schema/config.schema.json",
  "failOn": "high",
  "exclude": ["generated/**", "**/*.snap"],
  "allowMissingEngines": false,
  "lineFilter": true,
  "baseline": ".code-intel/baseline.json",
  "profiles": {
    "quick": { "engines": ["secrets", "sast", "deps"], "timeoutMs": 60000 },
    "deep": { "engines": ["secrets", "sast", "deps", "architecture"], "timeoutMs": 600000 }
  },
  "engines": {
    "gitleaks": { "configPath": ".gitleaks.toml" },
    "semgrep": { "configs": ["p/default", ".semgrep/rules"] }
  }
}
```

| Key                           | Default                     | Notes                                                                                                                     |
| ----------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `failOn`                      | `high`                      | Lowest severity that gives exit 1                                                                                         |
| `exclude`                     | `[]`                        | **Added to** built-ins: `.git`, `node_modules`, `vendor`, `dist`, `build`, `coverage`, `.code-intel`, `*.min.js`, `*.map` |
| `allowMissingEngines`         | `false`                     | Missing engine → warning instead of exit 3                                                                                |
| `lineFilter`                  | `true`                      | Hide SAST findings on untouched lines in changed-file scans                                                               |
| `baseline`                    | `.code-intel/baseline.json` | Repo-relative; may not point into `.git` or at the config file                                                            |
| `profiles.<name>.engines`     | see README                  | Categories or engine names                                                                                                |
| `profiles.<name>.timeoutMs`   | 60000 / 600000              | 1000–3600000                                                                                                              |
| `engines.gitleaks.configPath` | none                        | Falls back to `.gitleaks.toml` if present. `.gitleaksignore` is honored                                                   |
| `engines.semgrep.configs`     | `["p/default"]`             | Registry ids (`p/…`, `r/…`) or repo-relative paths. **URLs are rejected**                                                 |

## Configuration from untrusted repositories

The configuration lives in the repository, so whoever controls the repository controls it. Every report lists non-default repository settings under `config.inEffect` (and prints a note in the text report). When scanning code you did not write, pass `--ignore-repo-config`.

## Glob rules for `exclude`

Gitignore-style: a pattern without `/` matches that name at any depth and excludes everything below a matching directory; `*` does not cross `/`; `**`, `?`, `{a,b}` and `[abc]` work. Because a configuration can come from an untrusted repository, globs must be relative, contain no `..`, be at most 200 characters, use `**` at most 3 times and at most 12 wildcard characters. Violations are configuration errors, not slowdowns.

## Environment

`CODE_INTEL_CACHE_DIR` sets where cached results are stored (default: your user cache directory: `~/Library/Caches` on macOS, `$XDG_CACHE_HOME` or `~/.cache` on Linux, `%LOCALAPPDATA%` on Windows). Nothing else is read. Child engines inherit your environment (for example proxy settings); `NO_COLOR=1`, `SEMGREP_SEND_METRICS=off` and a `PWD` matching their working directory are set for them.
