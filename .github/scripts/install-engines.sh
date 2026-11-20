#!/usr/bin/env bash
# Installs the scanners code-intel drives, pinned to the versions the project is tested against.
# Linux x64 runners only. Everything lands in $HOME/.local/bin (added to PATH for later steps).
#
# Integrity: each binary's SHA-256 is pinned HERE, in the repository, so a swapped release asset is caught
# and every version bump is a reviewed change. To bump a tool: update its version and hash together, taking
# the hash from the project's published checksums file (and checking it against a second source).
# Residual risk, stated plainly: semgrep (pipx) and ast-grep/codegraph (npm) are installed by exact version
# from their registries without hash pinning.
set -euo pipefail

GITLEAKS=8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
OSV=2.7.1
OSV_SHA256=fb7dab19a8bd9bbe5c3189f09d4b7ee1820c9553a23bac202648a56efd2f6ee8
TRIVY=0.76.1
TRIVY_SHA256=c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0
SEMGREP=1.186.0
ASTGREP=0.51.3
CODEGRAPH=1.2.0

BIN="$HOME/.local/bin"
mkdir -p "$BIN"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch_pinned() { # <url> <expected-sha256> <output-file>
  curl -fsSL -o "$3" "$1"
  echo "$2  $3" | sha256sum -c - >/dev/null || { echo "checksum mismatch for $1" >&2; exit 1; }
}

fetch_pinned "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS}/gitleaks_${GITLEAKS}_linux_x64.tar.gz" "$GITLEAKS_SHA256" "$tmp/gitleaks.tgz"
tar -xzf "$tmp/gitleaks.tgz" -C "$tmp" gitleaks
install -m 0755 "$tmp/gitleaks" "$BIN/gitleaks"

fetch_pinned "https://github.com/google/osv-scanner/releases/download/v${OSV}/osv-scanner_linux_amd64" "$OSV_SHA256" "$tmp/osv-scanner"
install -m 0755 "$tmp/osv-scanner" "$BIN/osv-scanner"

fetch_pinned "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY}/trivy_${TRIVY}_Linux-64bit.tar.gz" "$TRIVY_SHA256" "$tmp/trivy.tgz"
tar -xzf "$tmp/trivy.tgz" -C "$tmp" trivy
install -m 0755 "$tmp/trivy" "$BIN/trivy"

pipx install "semgrep==${SEMGREP}"
npm install --global "@ast-grep/cli@${ASTGREP}" "@colbymchenry/codegraph@${CODEGRAPH}"

echo "$BIN" >> "${GITHUB_PATH:-/dev/null}"
export PATH="$BIN:$PATH"
gitleaks version
semgrep --version
osv-scanner --version
trivy --version
ast-grep --version
codegraph --version
