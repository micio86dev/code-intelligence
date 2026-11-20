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

# Every downloaded binary is verified against the SHA-256 its project publishes for the pinned release.
fetch_verified() { # <url> <checksums-url> <asset-name> <output-file>
  local url="$1" sums="$2" name="$3" out="$4"
  curl -fsSL -o "$out" "$url"
  curl -fsSL -o "$tmp/sums.txt" "$sums"
  local expected
  expected="$(awk -v n="$name" '$2 == n || $2 == "*"n {print $1}' "$tmp/sums.txt")"
  [ -n "$expected" ] || { echo "no checksum published for $name" >&2; exit 1; }
  echo "$expected  $out" | sha256sum -c - >/dev/null || { echo "checksum mismatch for $name" >&2; exit 1; }
}

fetch_verified "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS}/gitleaks_${GITLEAKS}_linux_x64.tar.gz" \
  "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS}/gitleaks_${GITLEAKS}_checksums.txt" \
  "gitleaks_${GITLEAKS}_linux_x64.tar.gz" "$tmp/gitleaks.tgz"
tar -xzf "$tmp/gitleaks.tgz" -C "$tmp" gitleaks
install -m 0755 "$tmp/gitleaks" "$BIN/gitleaks"

fetch_verified "https://github.com/google/osv-scanner/releases/download/v${OSV}/osv-scanner_linux_amd64" \
  "https://github.com/google/osv-scanner/releases/download/v${OSV}/osv-scanner_SHA256SUMS" \
  "osv-scanner_linux_amd64" "$tmp/osv-scanner"
install -m 0755 "$tmp/osv-scanner" "$BIN/osv-scanner"

fetch_verified "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY}/trivy_${TRIVY}_Linux-64bit.tar.gz" \
  "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY}/trivy_${TRIVY}_checksums.txt" \
  "trivy_${TRIVY}_Linux-64bit.tar.gz" "$tmp/trivy.tgz"
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
