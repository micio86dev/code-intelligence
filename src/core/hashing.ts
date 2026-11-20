import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_FILES = 2000;

/**
 * Content hash of repo-relative files or directories (recursive, sorted, links skipped). Used for cache
 * keys: a result may only be reused if the configuration that produced it is byte-identical, including
 * rule files that live in the repository.
 */
export function hashPaths(root: string, rels: readonly string[]): string {
  const h = createHash("sha256");
  let count = 0;
  const visit = (rel: string): void => {
    if (count > MAX_FILES) return;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(join(root, rel));
    } catch {
      h.update(`${rel}\0missing\0`);
      return;
    }
    if (st.isSymbolicLink()) {
      h.update(`${rel}\0link\0`);
    } else if (st.isDirectory()) {
      for (const name of readdirSync(join(root, rel)).sort()) visit(`${rel}/${name}`);
    } else if (st.isFile()) {
      count += 1;
      h.update(`${rel}\0`);
      h.update(
        createHash("sha256")
          .update(readFileSync(join(root, rel)))
          .digest(),
      );
    }
  };
  for (const r of [...rels].sort()) visit(r);
  if (count > MAX_FILES) h.update("truncated");
  return h.digest("hex");
}
