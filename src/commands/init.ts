import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE } from "../core/config.ts";
import { UsageError } from "../core/errors.ts";
import { findGitRoot } from "../core/targets.ts";

const TEMPLATE = {
  $schema:
    "https://raw.githubusercontent.com/micio86dev/code-intelligence/main/schema/config.schema.json",
  failOn: "high",
  exclude: [],
};

/** Create .code-intel.json and the .code-intel/ working dir. Never overwrites anything. */
export async function runInit(cwd: string): Promise<{ created: string[] }> {
  const root = (await findGitRoot(cwd)) ?? cwd;
  const file = join(root, CONFIG_FILE);
  if (existsSync(file)) throw new UsageError(`${CONFIG_FILE} already exists; leaving it untouched`);
  writeFileSync(file, `${JSON.stringify(TEMPLATE, null, 2)}\n`);
  const dir = join(root, ".code-intel");
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  const created = [CONFIG_FILE];
  if (!existsSync(ignore)) {
    writeFileSync(ignore, "cache/\n");
    created.push(".code-intel/.gitignore");
  }
  return { created };
}
