import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { LineRange, ScanTarget, TargetMode } from "../types.ts";
import { UsageError } from "./errors.ts";
import { exec } from "./exec.ts";
import { compileGlobs } from "./glob.ts";

const GIT_TIMEOUT = 30_000;
// A repository can carry its own git configuration (a copied or extracted .git directory). Neutralize the
// settings that make `git diff`/`ls-files` run external programs: fsmonitor hooks and textconv/external diff.
const GIT = ["-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "diff.external="];

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

/**
 * Parse `git diff -U0` output into added-line ranges per file.
 *
 * File headers (`+++ path`) are only recognized in a file's header block, and hunk bodies are consumed
 * by the exact line counts their `@@` header declares. Without that, an added source line such as
 * `++ /dev/null` renders as `+++ /dev/null` and would be mistaken for a header, silently dropping the
 * rest of the file's hunks and hiding findings from the changed-line filter.
 */
export function parseChangedLines(diff: string): Map<string, LineRange[]> {
  const result = new Map<string, LineRange[]>();
  let current: string | null = null;
  let inHeader = false;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      // Inside a hunk body: whatever the content looks like, it is content.
      if (line.startsWith("+")) newLeft -= 1;
      else if (line.startsWith("-")) oldLeft -= 1;
      else if (!line.startsWith("\\")) {
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      current = null;
    } else if (inHeader && line.startsWith("+++ ")) {
      let p = line.slice(4).split("\t")[0] as string;
      if (p === "/dev/null") {
        current = null;
        continue;
      }
      if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
      current = p.startsWith("b/") ? p.slice(2) : p;
      if (!result.has(current)) result.set(current, []);
    } else if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      inHeader = false;
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLeft = m[3] === undefined ? 1 : Number(m[3]);
      const start = Number(m[2]);
      if (current && newLeft > 0) result.get(current)?.push({ start, end: start + newLeft - 1 });
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
    diffArgs = [
      "diff",
      "--cached",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--diff-filter=ACMR",
    ];
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
      diffArgs = [
        "diff",
        "-U0",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--diff-filter=ACMR",
        base,
      ];
    }
  }

  const isExcluded = compileGlobs(opts.exclude);
  let realRoot = root;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    /* keep the logical root */
  }
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
      const abs = join(root, rel);
      if (!lstatSync(abs).isFile()) continue; // drops deleted files, symlinks, submodules
      // The last component is not a link, but a parent directory might be (a worktree that differs from the
      // index). Never read a file whose real location is outside the repository.
      const real = realpathSync.native(abs);
      if (real !== realRoot && !real.startsWith(realRoot + sep)) {
        excludedCount += 1;
        continue;
      }
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
