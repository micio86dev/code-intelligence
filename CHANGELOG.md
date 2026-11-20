# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0]

### Added

- `scan` with gitleaks (secrets), semgrep (SAST), osv-scanner with trivy fallback (dependencies) and ast-grep (architecture rules from the project's `sgconfig.yml`); `changed`, `staged`, `since` and `all` scopes; `quick` and `deep` profiles.
- Normalized findings with stable fingerprints, severity, location and remediation; text, JSON (`schemaVersion` 1) and SARIF 2.1.0 output.
- Exit code 3 for incomplete scans: missing engines, timeouts and crashes are never reported as a pass.
- `baseline` and `--new-only`; changed-line filtering for SAST with an explicit "hidden" count.
- `impact` (CodeGraph transitive, labelled heuristic fallback) and `mutate` (StrykerJS, scoped to changed lines).
- `doctor`, `init`, structured logging, JSON Schemas for config and report.
- Exact-match result cache for engines whose output is a pure function of file contents.

### Security

Found by scanning this repository with itself and by an independent review that reproduced each issue; all fixed with regression tests before release:

- Glob matching is now linear-time with no regular expressions (an earlier capped-regex version was still exploitable).
- The changed-line diff parser can no longer be fooled by added lines that look like file headers.
- Cache, baseline and `init` writes never follow symlinks; baseline cannot target `.git`; a symlinked config or baseline is refused without echoing its contents.
- Files reached through a symlinked parent directory are not scanned; `git` runs with textconv and external diff disabled.
- Repository-supplied configuration that weakens a scan is always disclosed; `--ignore-repo-config` discards it.
- Cache entries are validated and keyed by config and rule-file contents (previously, editing a rule or `.gitleaks.toml` did not invalidate cached results).
- Secrets-category semgrep findings use a fixed message; text output escapes control characters; identical lines get distinct fingerprints; `impact` no longer has a quadratic regex; engine downloads in CI are checksum-verified.
