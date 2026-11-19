import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LineRange, ScanTarget, TargetMode } from "../types.ts";
import { UsageError } from "./errors.ts";
import { exec } from "./exec.ts";
import { compileGlobs } from "./glob.ts";

const GIT_TIMEOUT = 30_000;
const GIT = ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false"];

async function git(
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; out: string; err: string }> {
  const r = await exec("git", [...GIT, ...args], { cwd, timeoutMs: GIT_TIMEOUT });
  if (r.spawnError)
    throw new UsageError("git is required for changed-file scans but was not found on PATH");
  return { ok: r.code === 0, out: r.stdout, err: r.stderr };
}

const splitZ = (s: string): string[] => s.split("\0").filter(Boolean);

export async function findGitRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.ok ? r.out.trim() : null;
}

async function hasCommits(root: string): Promise<boolean> {
  return (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
}

/** Parse `git diff -U0` output into added-line ranges per file. */
export function parseChangedLines(diff: string): Map<string, LineRange[]> {
  const result = new Map<string, LineRange[]>();
  let current: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      let p = line.slice(4).split("\t")[0] as string;
      if (p === "/dev/null") {
        current = null;
        continue;
      }
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      current = p.startsWith("b/") ? p.slice(2) : p;
      if (!result.has(current)) result.set(current, []);
    } else if (line.startsWith("@@") && current) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) result.get(current)?.push({ start, end: start + count - 1 });
    }
  }
  return result;
}

function walk(root: string, rel = "", out: string[] = []): string[] {
  for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.name === ".git" || ent.name === "node_modules") continue;
    if (ent.isDirectory()) walk(root, r, out);
    else if (ent.isFile()) out.push(r);
  }
  return out;
}

export interface TargetOptions {
  cwd: string;
  mode: TargetMode | null;
  ref: string | null;
  exclude: readonly string[];
}

export async function resolveTarget(opts: TargetOptions): Promise<ScanTarget> {
  const gitRoot = await findGitRoot(opts.cwd);
  const isGit = gitRoot !== null;
  const mode: TargetMode = opts.mode ?? (isGit ? "changed" : "all");
  const root = gitRoot ?? opts.cwd;

  if (!isGit && mode !== "all") {
    throw new UsageError(
      `--${mode === "since" ? "since" : mode} needs a git repository; use --all outside git`,
    );
  }

  let rels: string[] = [];
  let diffArgs: string[] | null = null;
  let untracked: string[] = [];

  if (!isGit) {
    rels = walk(root);
  } else if (mode === "all") {
    rels = splitZ(
      (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).out,
    );
  } else if (mode === "staged") {
    rels = splitZ(
      (await git(root, ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"])).out,
    );
    diffArgs = ["diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR"];
  } else {
    let base = "HEAD";
    if (mode === "since") {
      const ref = opts.ref ?? "";
      if (!ref || ref.startsWith("-"))
        throw new UsageError("--since needs a git ref (e.g. main or HEAD~3)");
      const v = await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (!v.ok) throw new UsageError(`--since: '${ref}' is not a valid commit in this repository`);
      base = v.out.trim();
    }
    untracked = splitZ((await git(root, ["ls-files", "-z", "--others", "--exclude-standard"])).out);
    if (mode === "changed" && !(await hasCommits(root))) {
      // Fresh repo without commits: everything is new.
      rels = splitZ(
        (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).out,
      );
    } else {
      const tracked = await git(root, ["diff", "--name-only", "-z", "--diff-filter=ACMR", base]);
      if (!tracked.ok)
        throw new UsageError(`git diff failed: ${tracked.err.trim().split("\n")[0]}`);
      rels = [...splitZ(tracked.out), ...untracked];
      diffArgs = ["diff", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR", base];
    }
  }

  const isExcluded = compileGlobs(opts.exclude);
  const seen = new Set<string>();
  const files: string[] = [];
  let excludedCount = 0;
  for (const raw of rels) {
    const rel = raw.replace(/\\/g, "/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (isExcluded(rel)) {
      excludedCount += 1;
      continue;
    }
    try {
      if (!lstatSync(join(root, rel)).isFile()) continue; // drops deleted files, symlinks, submodules
    } catch {
      continue;
    }
    files.push(rel);
  }
  files.sort();

  let changedLines = new Map<string, LineRange[]>();
  if (diffArgs) {
    const d = await git(root, diffArgs);
    if (d.ok) changedLines = parseChangedLines(d.out);
    // Untracked files have no diff: absence of an entry means "whole file".
    for (const u of untracked) changedLines.delete(u);
  }

  return { root, mode, ref: opts.ref, isGit, files, changedLines, excludedCount };
}
