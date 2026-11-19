#!/usr/bin/env bash
# Installs the scanners code-intel drives, pinned to the versions the project is tested against.
# Linux x64 runners only. Everything lands in $HOME/.local/bin (added to PATH for later steps).
set -euo pipefail

GITLEAKS=8.30.1
OSV=2.7.1
TRIVY=0.76.1
SEMGREP=1.186.0
ASTGREP=0.51.3
CODEGRAPH=1.2.0

BIN="$HOME/.local/bin"
mkdir -p "$BIN"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS}/gitleaks_${GITLEAKS}_linux_x64.tar.gz" | tar -xz -C "$tmp" gitleaks
install -m 0755 "$tmp/gitleaks" "$BIN/gitleaks"

curl -fsSL -o "$BIN/osv-scanner" "https://github.com/google/osv-scanner/releases/download/v${OSV}/osv-scanner_linux_amd64"
chmod 0755 "$BIN/osv-scanner"

curl -fsSL "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY}/trivy_${TRIVY}_Linux-64bit.tar.gz" | tar -xz -C "$tmp" trivy
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
