import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_FILES = 5000;
const MAX_BYTES = 1_000_000;
/** Engine-native inline suppressions: a line carrying one is skipped by the engine, whatever the config says. */
const INLINE = /gitleaks:allow|nosemgrep/g;

/**
 * Count inline suppression comments (`# gitleaks:allow`, `# nosemgrep`) in the files being scanned. They are
 * honored by the engines and cannot be turned off by `--ignore-repo-config`, so a hostile repository can use
 * them to hide a finding; the report states how many exist instead of leaving them invisible.
 */
export function countInlineSuppressions(root: string, files: readonly string[]): number {
  let n = 0;
  for (const f of files.slice(0, MAX_FILES)) {
    try {
      const abs = join(root, f);
      const st = lstatSync(abs);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      n += (readFileSync(abs, "utf8").match(INLINE) ?? []).length;
    } catch {
      /* unreadable: nothing to count */
    }
  }
  return n;
}
