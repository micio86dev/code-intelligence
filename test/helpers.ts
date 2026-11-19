import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Hermetic git env: ignores the developer's global config, hooks and templates. */
export const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/**
 * Environment for processes that run *inside* a fixture project: drops the parent test runner's
 * and `npm run`'s context (NODE_TEST_CONTEXT, npm_*), which would otherwise make a nested
 * `node --test` a no-op or a nested `npm install` operate on the outer project.
 */
export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(GIT_ENV)) {
    if (v === undefined || k === "NODE_TEST_CONTEXT" || k.toLowerCase().startsWith("npm_"))
      continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

export interface Project {
  dir: string;
  write(rel: string, content: string): void;
  commit(msg?: string): void;
  cleanup(): void;
}

/** Create a temp project (optionally a git repo) from a path->content map. */
export function makeProject(
  files: Record<string, string> = {},
  opts: { git?: boolean } = {},
): Project {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ci-test-")));
  const write = (rel: string, content: string) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  const useGit = opts.git ?? true;
  if (useGit) git(dir, "init", "-q", "-b", "main", "--template=");
  return {
    dir,
    write,
    commit(msg = "snapshot") {
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "--no-verify", "--no-gpg-sign", "-m", msg);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Build secret-shaped strings at runtime so no scannable secret lives in this repo's source. */
export const fakeAwsKey = () => `AKIA${"QYLPMN5HHXWF2ZPD"}`;
