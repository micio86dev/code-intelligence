# Roadmap

Honest list. Items are _not_ promised and nothing here is claimed to work today.

## Next

- **npm registry publishing** with provenance (needs an npm account/token; the release workflow already supports it when `NPM_TOKEN` is set).
- **Offline mode**: expose osv-scanner `--offline-vulnerabilities`, trivy `--skip-db-update --offline-scan`, and require local semgrep rules, for air-gapped or privacy-restricted use.
- **Mutation testing beyond JS/TS**: `cargo-mutants` (Rust; supports `--in-diff`) and `mutmut` (Python). Each ships only once validated end to end.
- **`dependency-cruiser` engine** for JS/TS dependency rules, alongside ast-grep.
- **Property-based testing guidance** in the skills (fast-check / Hypothesis). This is a test-library technique, so it is documentation, not an engine.

## Later / ideas

- Per-language profiles; `--since` with merge-base semantics.
- Better reuse of results between runs where inputs are provably identical.
- A `--explain <fingerprint>` command.

## Explicitly out of scope

LLM calls, orchestration, memory, a daemon or MCP server, a rules marketplace.
