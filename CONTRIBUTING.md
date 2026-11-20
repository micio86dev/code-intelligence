# Contributing

Thanks for helping. This project values small, boring, well-tested code.

## Setup

```bash
git clone https://github.com/micio86dev/code-intelligence && cd code-intelligence
npm install
npm run build
```

Requires Node.js 22+ (24 recommended; tests run TypeScript directly via Node's type stripping, so **no enums and no constructor parameter properties**; `erasableSyntaxOnly` enforces this).

To run the integration tests you need the engines: `brew install gitleaks semgrep osv-scanner ast-grep trivy` (or equivalents) and optionally `codegraph`. Set `CODE_INTEL_OFFLINE=1` to skip tests that need the network.

## Checks

```bash
npm run lint && npm run typecheck
npm test
npm run test:e2e
npm run test:integration
npm run test:install
npm run test:all
```

- `npm test`: unit, fast, no engines needed
- `npm run test:e2e`: real CLI against real engines
- `npm run test:integration`: StrykerJS (installs it into a temp project)
- `npm run test:install`: pack, install into a clean prefix, uninstall

CI runs the unit tests on Linux, macOS and Windows (Node 22 and 24), the engine-backed tests (e2e, integration, install) on Linux where all engines are installed, and scans this repository with itself. **Findings from `code-intel scan --all` on this repo must be fixed or justified inline** (a `nosemgrep` comment with the reason).

## Rules of the road

- **No placeholder features.** A capability ships only if it is tested against the real tool. Say "unsupported" in the docs instead.
- **Never silently skip a check.** Anything that did not run must surface as `skipped` (with a reason), `unavailable`, `timeout` or `error`, and must not yield exit 0 unless it is a documented no-op.
- **Tests assert behavior through the public CLI where possible**, including exit codes and that no secret appears in any output.
- **Hermetic tests.** Use `makeProject()` from `test/helpers.ts` (own git identity, no templates or hooks) and `cleanEnv()` for child processes; never rely on your global git config. Build secret-shaped fixtures at runtime (`fakeAwsKey()`), never commit them.
- **Adding an engine:** implement `Engine` in `src/engines/`, register it in `registry.ts`, capture its real output format first, add an e2e test and a row in the docs and `THIRD_PARTY.md`. Mark it cacheable only if its output is a pure function of file contents.
- Zero runtime dependencies is a goal. Justify any addition.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Mutation testing this project

`code-intel mutate` works on this repository too. StrykerJS is deliberately **not** a dependency here (its transitive packages carried open advisories when last checked, and the committed lockfile must stay clean), so install it temporarily:

```bash
npm install --no-save @stryker-mutator/core@10.1.1
npm run build && node dist/cli.js mutate src/core/glob.ts
```

- `npm run build && node dist/cli.js mutate src/core/glob.ts`: about 5 minutes

`stryker.config.json` runs the unit tests and sets `tsconfigFile` to a non-existent file because this project uses TypeScript 7 (see docs/troubleshooting.md). The recorded results are in `bench/results/mutation-self.json`. A surviving mutant is a missing test: add one for it and re-run.

## Benchmarks

`node bench/run.mjs` reproduces `docs/benchmarks.md` (needs network and the engines). Do not edit numbers by hand.
