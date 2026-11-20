# Changelog

All notable changes to this project are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/), versioning follows [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.2]

### Fixed

- Documentation: shell code blocks no longer carry `# comments`. In zsh (the macOS default shell) an interactive `#` is not a comment, so a pasted line such as `git commit -q -m base   # note` passed the note's words to the command as arguments. Comments now sit in a list below each block, and the first-test guide is split into step-wise blocks. The blocks were run in interactive zsh without errors.

## [0.1.1]

### Changed

- README: a ten-minute first-test walkthrough (throwaway project with fake defects), npm registry install instructions, and the note that `0.1.0` was published without provenance. Documentation only; no code change.

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
- Secrets-category semgrep findings use a fixed message; text output escapes control and invisible (bidirectional, zero-width) characters; identical lines get distinct fingerprints; `impact` no longer has a quadratic regex.
- A second independent pass found the first fixes only partly effective; corrected before release:
  - `--ignore-repo-config` now truly ignores the repository's gitleaks config and ignore file (previously a staged `.gitleaks.toml` was still auto-discovered while the report claimed it was ignored); inline `gitleaks:allow` / `nosemgrep` comments and `.semgrepignore` are counted and disclosed.
  - The result cache moved **out of the repository** into the user's cache directory (`CODE_INTEL_CACHE_DIR` overrides it): a cache inside a scanned repository cannot be trusted.
  - Exclude globs are bounded in count, expansion and total matching work.
  - Git clean filters from a hostile `.git/config` are neutralized (not only textconv).
  - Protected baseline paths are normalized and case-folded; baseline reads refuse symlinked parents and never echo parser messages.
  - CI binary downloads use SHA-256 hashes pinned in the repository; the release job installs no third-party tools and requires the tag on `main` and a green CI run for the commit.

### Fixed

- A repository's own `.gitleaksignore` entries now take effect (gitleaks is run from the staging directory so its fingerprints are repo-relative, as in a manual run).
- Engine error details report the real exception line (not a Python traceback header) with absolute paths scrubbed.
