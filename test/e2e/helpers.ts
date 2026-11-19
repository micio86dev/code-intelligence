import { spawnSync } from "node:child_process";
import { GIT_ENV } from "../helpers.ts";

const CLI = new URL("../../src/cli.ts", import.meta.url).pathname;

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], cwd: string, env: Record<string, string> = {}): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...GIT_ENV, ...env },
    encoding: "utf8",
    timeout: 240_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export const OFFLINE = process.env.CODE_INTEL_OFFLINE === "1";
