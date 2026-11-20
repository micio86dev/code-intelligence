import { join } from "node:path";
import { CONFIG_FILE } from "../core/config.ts";
import { UsageError } from "../core/errors.ts";
import { lexists, safeWrite, UnsafePathError } from "../core/safefs.ts";
import { findGitRoot } from "../core/targets.ts";

const TEMPLATE = {
  $schema:
    "https://raw.githubusercontent.com/micio86dev/code-intelligence/main/schema/config.schema.json",
  failOn: "high",
  exclude: [],
};

/** Create .code-intel.json. Never overwrites anything and never follows a link. */
export async function runInit(cwd: string): Promise<{ created: string[] }> {
  const root = (await findGitRoot(cwd)) ?? cwd;
  // lstat-based: a dangling symlink named .code-intel.json counts as "exists" (existsSync would say no).
  if (lexists(join(root, CONFIG_FILE))) {
    throw new UsageError(`${CONFIG_FILE} already exists; leaving it untouched`);
  }
  try {
    safeWrite(root, CONFIG_FILE, `${JSON.stringify(TEMPLATE, null, 2)}\n`);
    return { created: [CONFIG_FILE] };
  } catch (e) {
    if (e instanceof UnsafePathError) throw new UsageError(`init: ${e.message}`);
    throw e;
  }
}
