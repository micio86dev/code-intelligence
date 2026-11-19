import { readFileSync } from "node:fs";

/** Read from package.json at runtime; works from both src/ (tests) and dist/ (installed). */
export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return "0.0.0-unknown";
  }
})();

export const TOOL_NAME = "code-intelligence";
