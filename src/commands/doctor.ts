import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultCacheDir } from "../core/cache.ts";
import { CONFIG_FILE, loadConfig } from "../core/config.ts";
import { UsageError } from "../core/errors.ts";
import { findBinary } from "../core/exec.ts";
import { findGitRoot } from "../core/targets.ts";
import type { Engine } from "../engines/engine.ts";
import { ENGINES } from "../engines/registry.ts";
import type { Category } from "../types.ts";
import { TOOL_NAME, VERSION } from "../version.ts";

export interface DoctorReport {
  tool: { name: string; version: string };
  node: string;
  git: boolean;
  repository: boolean;
  config: { file: string; present: boolean; valid: boolean; errors: string[] };
  engines: Array<{
    name: string;
    category: Category;
    available: boolean;
    version: string | null;
    hint: string | null;
  }>;
  optional: Array<{ name: string; available: boolean; note: string }>;
  /** Where cached results are kept (outside the repository); `~` stands for the home directory. */
  cacheDir: string;
  ok: boolean;
}

export async function runDoctor(
  cwd: string,
  engines: readonly Engine[] = ENGINES,
): Promise<DoctorReport> {
  const gitRoot = await findGitRoot(cwd).catch(() => null);
  const root = gitRoot ?? cwd;
  const cfg: DoctorReport["config"] = {
    file: CONFIG_FILE,
    present: existsSync(join(root, CONFIG_FILE)),
    valid: true,
    errors: [],
  };
  try {
    loadConfig(
      root,
      engines.map((e) => e.name),
    );
  } catch (e) {
    if (e instanceof UsageError) {
      cfg.valid = false;
      cfg.errors = [e.message, ...e.details];
    } else throw e;
  }
  const detections = await Promise.all(engines.map((e) => e.detect()));
  const report: DoctorReport = {
    tool: { name: TOOL_NAME, version: VERSION },
    node: process.version,
    git: findBinary("git") !== null,
    repository: gitRoot !== null,
    config: cfg,
    engines: engines.map((e, i) => {
      const d = detections[i];
      return {
        name: e.name,
        category: e.category,
        available: d?.available ?? false,
        version: d?.version ?? null,
        hint: d?.available ? null : e.installHint,
      };
    }),
    optional: [
      {
        name: "codegraph",
        available: findBinary("codegraph") !== null,
        note: "used by `code-intel impact` for import-graph test selection",
      },
    ],
    cacheDir: defaultCacheDir(root).replace(homedir(), "~"),
    ok: false,
  };
  report.ok = report.git && cfg.valid && report.engines.every((e) => e.available);
  return report;
}

export function renderDoctor(r: DoctorReport): string {
  const L = [`${r.tool.name} ${r.tool.version} | node ${r.node}`, ""];
  L.push(`git: ${r.git ? "found" : "MISSING (needed for changed-file scans)"}`);
  L.push(
    `repository: ${r.repository ? "git repository" : "not a git repository (only --all scans work)"}`,
  );
  L.push(
    `config: ${r.config.present ? (r.config.valid ? `${r.config.file} valid` : `${r.config.file} INVALID`) : `no ${r.config.file} (defaults in use)`}`,
  );
  for (const e of r.config.errors) L.push(`  - ${e}`);
  L.push("", "Engines");
  for (const e of r.engines) {
    L.push(
      `  [${e.available ? "ok" : "MISSING"}] ${e.name.padEnd(14)} ${e.category.padEnd(8)} ${e.available ? (e.version ?? "") : (e.hint ?? "")}`,
    );
  }
  L.push("", `Result cache: ${r.cacheDir} (outside the repository; safe to delete)`);
  L.push("", "Optional");
  for (const o of r.optional)
    L.push(`  [${o.available ? "ok" : "absent"}] ${o.name.padEnd(14)} ${o.note}`);
  L.push(
    "",
    r.ok
      ? "Ready."
      : "Some engines are missing: scans that need them report 'unavailable' (exit 3) instead of passing.",
  );
  return `${L.join("\n")}\n`;
}
