import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.ts";
import { exec, findBinary } from "../core/exec.ts";
import type { Logger } from "../core/logger.ts";
import { resolveTarget } from "../core/targets.ts";
import { ENGINES } from "../engines/registry.ts";
import type { TargetMode } from "../types.ts";
import { TOOL_NAME, VERSION } from "../version.ts";

export interface ImpactReport {
  schemaVersion: 1;
  tool: { name: string; version: string };
  /** "codegraph": transitive import graph. "heuristic": direct importers and name matches only. */
  method: "codegraph" | "heuristic";
  target: { mode: TargetMode; ref: string | null; fileCount: number };
  changedFiles: string[];
  /** Test files that changed themselves plus tests that depend on changed code. */
  affectedTests: string[];
  notes: string[];
}

const TEST_RE = [
  /(^|\/)(__tests__|tests?|specs?)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go|rs)$/,
  /(Test|Tests|IT)\.(java|kt|cs)$/,
];
export const isTestFile = (p: string): boolean => TEST_RE.some((re) => re.test(p));

const SOURCE_RE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|rb|php|swift)$/;
const stem = (p: string): string => {
  const base = p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  if (base === "index" || base === "__init__" || base === "mod") {
    const parts = p.split("/");
    return parts[parts.length - 2] ?? base;
  }
  return base;
};

// Horizontal whitespace only: `\s*` on a file of many blank lines is quadratic (verified: 400 KB took 65 s).
const IMPORT_RE =
  /(?:from|require\(|import\()[ \t]*['"]([^'"]+)['"]|^[ \t]*(?:from|import)[ \t]+([\w.]+)/gm;
const MAX_SCAN_BYTES = 1_000_000;

/** Direct importers + name matches. Honest but shallow: it cannot see transitive dependents. */
function heuristic(
  root: string,
  changed: readonly string[],
  allFiles: readonly string[],
): string[] {
  const stems = new Set(changed.filter((f) => !isTestFile(f)).map(stem));
  const hits = new Set<string>();
  for (const t of allFiles.filter((f) => isTestFile(f) && SOURCE_RE.test(f))) {
    const tStem = t
      .slice(t.lastIndexOf("/") + 1)
      .replace(/\.(test|spec)(?=\.)/, "")
      .replace(/^test_|_test(?=\.)/, "")
      .replace(/\.[^.]+$/, "");
    if (stems.has(tStem)) {
      hits.add(t);
      continue;
    }
    let src: string;
    try {
      if (statSync(join(root, t)).size > MAX_SCAN_BYTES) continue;
      src = readFileSync(join(root, t), "utf8");
    } catch {
      continue;
    }
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = (m[1] ?? m[2] ?? "").replace(/\.[cm]?[jt]sx?$/, "");
      const last = spec.split(/[/.]/).filter(Boolean).pop() ?? "";
      if (stems.has(last)) {
        hits.add(t);
        break;
      }
    }
  }
  return [...hits];
}

export async function runImpact(opts: {
  cwd: string;
  mode: TargetMode | null;
  ref: string | null;
  log: Logger;
}): Promise<ImpactReport> {
  const mode = opts.mode ?? "changed";
  const probe = await resolveTarget({ cwd: opts.cwd, mode, ref: opts.ref, exclude: [] });
  const config = loadConfig(
    probe.root,
    ENGINES.map((e) => e.name),
  );
  const target = await resolveTarget({
    cwd: opts.cwd,
    mode,
    ref: opts.ref,
    exclude: config.exclude,
  });
  const changed = target.files;
  const notes: string[] = [];
  const changedTests = changed.filter(isTestFile);
  const changedSource = changed.filter((f) => !isTestFile(f) && SOURCE_RE.test(f));

  const cg = findBinary("codegraph");
  const hasIndex = existsSync(join(target.root, ".codegraph"));
  let method: ImpactReport["method"] = "heuristic";
  let affected = new Set<string>(changedTests);

  if (cg && hasIndex) {
    // Bring the index up to date first; a stale index would silently under-report.
    const sync = await exec(cg, ["sync", "--quiet", target.root], {
      cwd: target.root,
      timeoutMs: 60_000,
    });
    const r =
      sync.code === 0
        ? await exec(cg, ["affected", "--stdin", "--json", "--path", target.root], {
            cwd: target.root,
            timeoutMs: 60_000,
            input: `${changedSource.join("\n")}\n`,
          })
        : null;
    try {
      if (!r || r.code !== 0)
        throw new Error(sync.code === 0 ? "codegraph affected failed" : "codegraph sync failed");
      const parsed = JSON.parse(r.stdout) as { affectedTests?: string[] };
      for (const t of parsed.affectedTests ?? []) affected.add(t);
      method = "codegraph";
    } catch (e) {
      notes.push(`codegraph was unavailable (${(e as Error).message}); fell back to the heuristic`);
      affected = new Set(changedTests);
    }
  } else if (cg && !hasIndex) {
    notes.push(
      "No .codegraph index in this repository. Run `codegraph init` for transitive, import-graph-accurate results.",
    );
  } else {
    notes.push(
      "codegraph is not installed. Install it and run `codegraph init` for transitive results.",
    );
  }

  if (method === "heuristic") {
    const all = await resolveTarget({
      cwd: opts.cwd,
      mode: "all",
      ref: null,
      exclude: config.exclude,
    });
    for (const t of heuristic(target.root, changed, all.files)) affected.add(t);
    notes.push(
      "Heuristic: only tests that directly import a changed module or share its name are listed. Transitive dependents are NOT detected.",
    );
  }
  if (changedSource.length === 0 && changedTests.length === 0)
    notes.push("No source or test files changed in scope.");

  return {
    schemaVersion: 1,
    tool: { name: TOOL_NAME, version: VERSION },
    method,
    target: { mode: target.mode, ref: target.ref, fileCount: changed.length },
    changedFiles: changed,
    affectedTests: [...affected].sort(),
    notes,
  };
}

export function renderImpact(r: ImpactReport): string {
  const L = [
    `${r.tool.name} ${r.tool.version} | impact | method: ${r.method} | ${r.changedFiles.length} changed file(s)`,
    "",
  ];
  L.push(`Tests to run (${r.affectedTests.length})`);
  for (const t of r.affectedTests) L.push(`  ${t}`);
  if (r.affectedTests.length === 0) L.push("  none found");
  for (const n of r.notes) L.push("", `Note: ${n}`);
  return `${L.join("\n")}\n`;
}
