# Security policy

Please report suspected vulnerabilities **privately** via GitHub's "Report a vulnerability" button on the repository's Security tab (private vulnerability reporting), rather than a public issue. Include the version (`code-intel --version`), the command, and a minimal reproduction.

You can expect an acknowledgement within a few days. This is a small open-source project maintained on a best-effort basis; there is no bounty.

Scope: the `code-intel` CLI and its published package. Vulnerabilities in the scanners it drives (gitleaks, semgrep, osv-scanner, trivy, ast-grep, StrykerJS, codegraph) should be reported to those projects.

The threat model is in [docs/security.md](docs/security.md).
