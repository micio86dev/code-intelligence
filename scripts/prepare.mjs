// Build on `npm install` from a git checkout (github:owner/repo installs); no-op in a published tarball.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (
  existsSync(new URL("../src", import.meta.url)) &&
  !existsSync(new URL("../dist/cli.js", import.meta.url))
) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["run", "build"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  process.exit(r.status ?? 1);
}
