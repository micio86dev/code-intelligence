import { parseArgs } from "node:util";
import { renderDoctor, runDoctor } from "./commands/doctor.ts";
import { renderImpact, runImpact } from "./commands/impact.ts";
import { runInit } from "./commands/init.ts";
import { renderMutation, runMutate } from "./commands/mutate.ts";
import { runScan, type ScanReport } from "./commands/scan.ts";
import { saveBaseline } from "./core/baseline.ts";
import { UsageError } from "./core/errors.ts";
import { createLogger, isLogLevel, type LogFormat, type LogLevel } from "./core/logger.ts";
import { renderJson } from "./report/json.ts";
import { renderSarif } from "./report/sarif.ts";
import { renderText } from "./report/text.ts";
import { isSeverity, PROFILES, type ProfileName, type TargetMode } from "./types.ts";
import { VERSION } from "./version.ts";

export interface Io {
  cwd: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

const HELP = `code-intel ${VERSION}: run security and quality scanners on what changed, normalize the findings.

Usage: code-intel <command> [options]

Commands:
  scan       Run engines on changed files (or the whole repo) and report findings
  baseline   Record current findings so later scans can report only new ones
  mutate     Mutation-test changed code (StrykerJS) to find gaps in your tests
  impact     List the tests affected by your changes (uses codegraph when indexed)
  doctor     Check which engines are installed and whether the config is valid
  init       Create .code-intel.json in the current repository

Global options:
  -h, --help                 Show help (also: code-intel <command> --help)
  -v, --version              Print the version
      --log-level <level>    silent | error | warn (default) | info | debug   (logs go to stderr)
      --log-format <format>  text (default) | json

Exit codes: 0 ok, 1 findings at/above --fail-on, 2 usage or config error, 3 incomplete scan.
Docs: https://github.com/micio86dev/code-intelligence#readme
`;

const SCAN_HELP = `Usage: code-intel scan [options]

Scope (default: --changed inside a git repo, --all otherwise):
      --changed            Uncommitted changes versus HEAD, plus untracked files
      --staged             Only what is staged for commit
      --since <ref>        Working tree versus a git ref (e.g. main, HEAD~3)
      --all                Every tracked and untracked, non-ignored file

Options:
  -p, --profile <name>     quick (default): secrets, SAST, dependencies. deep: adds architecture, longer timeouts
  -e, --engines <list>     Comma-separated engines or categories (secrets, sast, deps, architecture)
  -f, --format <format>    text (default) | json | sarif
      --new-only           Hide findings recorded in the baseline (see: code-intel baseline)
      --fail-on <severity> info | low | medium | high (default) | critical
      --timeout <ms>       Per-engine time limit (default depends on profile)
      --allow-missing      Do not treat a missing engine as an incomplete scan
      --no-cache           Do not read or write cached engine results
      --ignore-repo-config Ignore the repository's own configuration (.code-intel.json, .gitleaks.toml,
                           .gitleaksignore, baseline). Use it when scanning code you do not trust:
                           a hostile repository can configure a scan to find nothing
`;

const IMPACT_HELP = `Usage: code-intel impact [--changed | --staged | --since <ref>] [--json]

Lists the test files affected by your changes. With a codegraph index (run \`codegraph init\` once)
the answer follows the import graph transitively. Without one it falls back to a labelled
heuristic (direct importers and name matches only). The index is synced before every query.
`;

const MUTATE_HELP = `Usage: code-intel mutate [files...] [--changed | --staged | --since <ref>] [options]

Mutation-tests changed JavaScript/TypeScript code with StrykerJS: it makes small behavior changes
("mutants") and runs your tests. A mutant your tests do not catch is a gap in the tests.
Without file arguments it mutates only the lines you changed. This is slow by design; use it
before merging or when asked about test quality, not after every edit.

Requires StrykerJS in the project: npm install --save-dev @stryker-mutator/core
Uses the project's stryker.config.* when present, otherwise runs its \`npm test\` script.

Options:
      --min-score <0-100>  Exit 1 when the mutation score is lower
      --timeout <ms>       Time limit for the whole run (default 600000)
      --json               Machine-readable output
`;

const SHARED = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  "log-level": { type: "string" },
  "log-format": { type: "string" },
} as const;

function render(format: string, r: ScanReport): string {
  return format === "json" ? renderJson(r) : format === "sarif" ? renderSarif(r) : renderText(r);
}

function parse(rest: string[]) {
  return parseArgs({
    args: rest,
    strict: true,
    allowPositionals: true,
    options: {
      ...SHARED,
      profile: { type: "string", short: "p" },
      engines: { type: "string", short: "e" },
      format: { type: "string", short: "f" },
      changed: { type: "boolean" },
      staged: { type: "boolean" },
      all: { type: "boolean" },
      since: { type: "string" },
      "new-only": { type: "boolean" },
      "fail-on": { type: "string" },
      timeout: { type: "string" },
      "allow-missing": { type: "boolean" },
      "no-cache": { type: "boolean" },
      "ignore-repo-config": { type: "boolean" },
      json: { type: "boolean" },
      "min-score": { type: "string" },
    },
  });
}

export async function main(argv: string[], io: Io): Promise<number> {
  try {
    const first = argv[0];
    if (first === undefined || first === "-h" || first === "--help" || first === "help") {
      io.stdout(HELP);
      return first === undefined ? 2 : 0;
    }
    if (first === "-v" || first === "--version") {
      io.stdout(`${VERSION}\n`);
      return 0;
    }
    const command = first;
    const rest = argv.slice(1);

    let parsed: ReturnType<typeof parse>;
    try {
      parsed = parse(rest);
    } catch (e) {
      throw new UsageError((e as Error).message, [`Run: code-intel ${command} --help`]);
    }
    const v = parsed.values;
    if (parsed.positionals.length > 0 && command !== "mutate") {
      throw new UsageError(`Unexpected argument '${parsed.positionals[0]}'`, [
        `Run: code-intel ${command} --help`,
      ]);
    }

    if (v.help) {
      io.stdout(
        command === "scan" || command === "baseline"
          ? SCAN_HELP
          : command === "impact"
            ? IMPACT_HELP
            : HELP,
      );
      return 0;
    }
    if (v.version) {
      io.stdout(`${VERSION}\n`);
      return 0;
    }

    const level = (v["log-level"] ?? "warn") as string;
    if (!isLogLevel(level))
      throw new UsageError(
        `--log-level must be one of silent, error, warn, info, debug (got '${level}')`,
      );
    const lfmt = (v["log-format"] ?? "text") as string;
    if (lfmt !== "text" && lfmt !== "json")
      throw new UsageError(`--log-format must be text or json (got '${lfmt}')`);
    const log = createLogger(level as LogLevel, lfmt as LogFormat, io.stderr);

    switch (command) {
      case "doctor": {
        const r = await runDoctor(io.cwd);
        io.stdout(v.json ? `${JSON.stringify(r, null, 2)}\n` : renderDoctor(r));
        return r.config.valid ? 0 : 2;
      }
      case "impact": {
        const modes: TargetMode[] = [];
        if (v.changed) modes.push("changed");
        if (v.staged) modes.push("staged");
        if (v.since !== undefined) modes.push("since");
        if (v.all)
          throw new UsageError(
            "impact does not support --all; use --changed, --staged or --since <ref>",
          );
        if (modes.length > 1) throw new UsageError("Use only one of --changed, --staged, --since");
        const r = await runImpact({
          cwd: io.cwd,
          mode: modes[0] ?? null,
          ref: v.since ?? null,
          log,
        });
        io.stdout(
          v.json || v.format === "json" ? `${JSON.stringify(r, null, 2)}\n` : renderImpact(r),
        );
        return 0;
      }
      case "mutate": {
        const modes: TargetMode[] = [];
        if (v.changed) modes.push("changed");
        if (v.staged) modes.push("staged");
        if (v.since !== undefined) modes.push("since");
        if (v.all)
          throw new UsageError(
            "mutate does not support --all (too slow to be useful); pass files or use --changed, --staged, --since <ref>",
          );
        if (modes.length > 1) throw new UsageError("Use only one of --changed, --staged, --since");
        if (modes.length > 0 && parsed.positionals.length > 0)
          throw new UsageError("Pass either files or a scope flag, not both");
        let minScore: number | null = null;
        if (v["min-score"] !== undefined) {
          minScore = Number(v["min-score"]);
          if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100)
            throw new UsageError("--min-score must be a number between 0 and 100");
        }
        let timeoutMs = 600_000;
        if (v.timeout !== undefined) {
          timeoutMs = Number(v.timeout);
          if (!Number.isInteger(timeoutMs) || timeoutMs < 1000)
            throw new UsageError("--timeout must be an integer number of milliseconds (>= 1000)");
        }
        const r = await runMutate({
          cwd: io.cwd,
          mode: modes[0] ?? null,
          ref: v.since ?? null,
          files: parsed.positionals,
          timeoutMs,
          minScore,
          log,
        });
        io.stdout(
          v.json || v.format === "json" ? `${JSON.stringify(r, null, 2)}\n` : renderMutation(r),
        );
        return r.exitCode;
      }
      case "init": {
        const { created } = await runInit(io.cwd);
        io.stdout(`Created: ${created.join(", ")}\n`);
        return 0;
      }
      case "scan":
      case "baseline": {
        const modes: TargetMode[] = [];
        if (v.changed) modes.push("changed");
        if (v.staged) modes.push("staged");
        if (v.since !== undefined) modes.push("since");
        if (v.all) modes.push("all");
        if (modes.length > 1)
          throw new UsageError("Use only one of --changed, --staged, --since, --all");

        const profile = (v.profile ?? "quick") as string;
        if (!(PROFILES as readonly string[]).includes(profile))
          throw new UsageError(`--profile must be quick or deep (got '${profile}')`);
        const format = (v.format ?? "text") as string;
        if (!["text", "json", "sarif"].includes(format))
          throw new UsageError(`--format must be text, json or sarif (got '${format}')`);
        if (v["fail-on"] !== undefined && !isSeverity(v["fail-on"]))
          throw new UsageError(
            `--fail-on must be one of info, low, medium, high, critical (got '${v["fail-on"]}')`,
          );
        let timeoutMs: number | null = null;
        if (v.timeout !== undefined) {
          timeoutMs = Number(v.timeout);
          if (!Number.isInteger(timeoutMs) || timeoutMs < 1000)
            throw new UsageError("--timeout must be an integer number of milliseconds (>= 1000)");
        }
        const isBaseline = command === "baseline";
        const { report, root, config } = await runScan({
          cwd: io.cwd,
          profile: profile as ProfileName,
          mode: isBaseline ? "all" : (modes[0] ?? null),
          ref: v.since ?? null,
          engines: v.engines
            ? v.engines
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : null,
          failOn: isBaseline ? null : ((v["fail-on"] as never) ?? null),
          timeoutMs,
          cache: !v["no-cache"],
          newOnly: isBaseline ? false : Boolean(v["new-only"]),
          ignoreRepoConfig: Boolean(v["ignore-repo-config"]),
          allowMissing: Boolean(v["allow-missing"]),
          log,
        });
        if (isBaseline) {
          if (!report.complete) {
            io.stdout(renderText(report));
            io.stderr(
              "Baseline not written: the scan was incomplete. Fix the engines above and retry.",
            );
            return 3;
          }
          const n = saveBaseline(root, config.baseline, report.findings);
          io.stdout(`Baseline written: ${n} finding(s) recorded in ${config.baseline}\n`);
          return 0;
        }
        io.stdout(render(format, report));
        return report.exitCode;
      }
      default:
        throw new UsageError(`Unknown command '${command}'`, ["Run: code-intel --help"]);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`error: ${e.message}`);
      for (const d of e.details) io.stderr(`  ${d}`);
      return 2;
    }
    io.stderr(`internal error: ${e instanceof Error ? e.message : String(e)}`);
    return 70;
  }
}
