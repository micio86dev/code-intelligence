import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RawFinding } from "../types.ts";

export interface CacheEntry {
  findings: RawFinding[];
  warnings: string[];
}

/**
 * Exact-match result cache. A key covers everything that can change an engine's output:
 * engine identity (binary path, size, mtime), its config inputs, and the content hash of
 * every input file. Any difference is a miss; there is no partial reuse and no TTL guesswork.
 */
export class ResultCache {
  private readonly dir: string;
  readonly enabled: boolean;
  constructor(root: string, enabled: boolean) {
    this.enabled = enabled;
    this.dir = join(root, ".code-intel", "cache");
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
    const h = createHash("sha256");
    h.update(`${engine}\0${identity}\0${inputs.join("\u0001")}\0`);
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
      return JSON.parse(readFileSync(join(this.dir, `${key}.json`), "utf8")) as CacheEntry;
    } catch {
      return null;
    }
  }

  put(key: string, entry: CacheEntry): void {
    if (!this.enabled) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, ".gitignore"), "*\n");
      const tmp = join(this.dir, `${key}.${process.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(entry));
      renameSync(tmp, join(this.dir, `${key}.json`)); // atomic: readers never see partial files
    } catch {
      /* a cache write failure must never fail a scan */
    }
  }
}
