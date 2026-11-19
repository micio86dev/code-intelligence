// Build on `npm install` from a git checkout (github:owner/repo installs); no-op in a published tarball.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (
  existsSync(new URL("../src", import.meta.url)) &&
  !existsSync(new URL("../dist/cli.js", import.meta.url))
) {
  // Run npm's own JS entry point with node: no shell, so nothing is interpreted by cmd.exe/sh.
  const npmCli = process.env.npm_execpath;
  const [cmd, args] = npmCli
    ? [process.execPath, [npmCli, "run", "build"]]
    : ["npm", ["run", "build"]];
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
