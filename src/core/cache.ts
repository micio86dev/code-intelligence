import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { CATEGORIES, isSeverity, type RawFinding } from "../types.ts";
import { VERSION } from "../version.ts";
import { isSafeGlob } from "./glob.ts";
import { lexists, safeWrite } from "./safefs.ts";

export interface CacheEntry {
  findings: RawFinding[];
  warnings: string[];
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isIntOrNull = (v: unknown): boolean =>
  v === null || (Number.isInteger(v) && (v as number) >= 0);

/**
 * Cache files live in the repository, so they are untrusted input: a committed entry could claim
 * "no findings" for a file that has some. Anything that is not exactly the shape we write is a miss.
 */
export function isCacheEntry(x: unknown): x is CacheEntry {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  if (!Array.isArray(e.warnings) || !e.warnings.every(isStr)) return false;
  if (!Array.isArray(e.findings)) return false;
  return e.findings.every((f) => {
    if (typeof f !== "object" || f === null) return false;
    const r = f as Record<string, unknown>;
    return (
      isStr(r.engine) &&
      isStr(r.ruleId) &&
      (CATEGORIES as readonly unknown[]).includes(r.category) &&
      isSeverity(r.severity) &&
      isStr(r.file) &&
      isSafeGlob(r.file) &&
      isIntOrNull(r.line) &&
      isIntOrNull(r.endLine) &&
      isStr(r.message) &&
      (r.remediation === null || isStr(r.remediation)) &&
      Array.isArray(r.references) &&
      r.references.every(isStr) &&
      (r.key === undefined || isStr(r.key))
    );
  });
}

/**
 * Exact-match result cache. A key covers everything that can change an engine's output: this tool's
 * version, the repository's real path, the engine binary identity, its config inputs, and the content
 * hash of every input file. Any difference is a miss; there is no partial reuse and no TTL guesswork.
 */
export class ResultCache {
  private readonly root: string;
  readonly enabled: boolean;
  constructor(root: string, enabled: boolean) {
    this.root = root;
    this.enabled = enabled;
  }

  static binaryIdentity(path: string | null): string {
    if (!path) return "none";
    try {
      const s = statSync(path);
      return `${path}:${s.size}:${s.mtimeMs}`;
    } catch {
      return path;
    }
  }

  static key(
    engine: string,
    identity: string,
    inputs: readonly string[],
    root: string,
    files: readonly string[],
  ): string {
    let realRoot = root;
    try {
      realRoot = realpathSync(root);
    } catch {
      /* keep the logical root */
    }
    const h = createHash("sha256");
    h.update(`v1\0${VERSION}\0${realRoot}\0${engine}\0${identity}\0${inputs.join("\u0001")}\0`);
    for (const f of [...files].sort()) {
      try {
        h.update(`${f}\0`);
        h.update(
          createHash("sha256")
            .update(readFileSync(join(root, f)))
            .digest(),
        );
      } catch {
        h.update("unreadable");
      }
    }
    return h.digest("hex");
  }

  get(key: string): CacheEntry | null {
    if (!this.enabled) return null;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(this.root, ".code-intel", "cache", `${key}.json`), "utf8"),
      );
      return isCacheEntry(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  put(key: string, entry: CacheEntry): void {
    if (!this.enabled) return;
    try {
      const ignore = ".code-intel/cache/.gitignore";
      if (!lexists(join(this.root, ignore))) safeWrite(this.root, ignore, "*\n");
      safeWrite(this.root, `.code-intel/cache/${key}.json`, JSON.stringify(entry));
    } catch {
      /* a cache write failure (including a refused symlink) must never fail a scan */
    }
  }
}
