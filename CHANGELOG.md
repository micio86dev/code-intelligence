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

- Glob complexity caps prevent regular-expression denial of service from untrusted configuration (found by scanning this repository with itself).
