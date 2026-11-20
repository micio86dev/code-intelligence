import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CATEGORIES, isSeverity, type RawFinding } from "../types.ts";
import { VERSION } from "../version.ts";
import { isSafeGlob } from "./glob.ts";

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
 * Where cached results live: the user's own cache directory, never the repository. A cache inside a repository
 * you scan is attacker-controlled (the key is predictable), so it cannot be trusted; one outside it can.
 * `CODE_INTEL_CACHE_DIR` overrides the location (tests, CI, or a RAM disk).
 */
export function defaultCacheDir(root: string): string {
  const override = process.env.CODE_INTEL_CACHE_DIR;
  let base: string;
  if (override) base = resolve(override);
  else if (process.platform === "win32") {
    base = join(
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "code-intelligence",
    );
  } else if (process.platform === "darwin") {
    base = join(homedir(), "Library", "Caches", "code-intelligence");
  } else {
    base = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "code-intelligence");
  }
  let real = root;
  try {
    real = realpathSync(root);
  } catch {
    /* keep the logical root */
  }
  return join(base, createHash("sha256").update(real).digest("hex").slice(0, 16));
}

/**
 * Exact-match result cache. A key covers everything that can change an engine's output: this tool's
 * version, the repository's real path, the engine binary identity, its config inputs, and the content
 * hash of every input file. Any difference is a miss; there is no partial reuse and no TTL guesswork.
 * Entries are still schema-validated on read (defense in depth).
 */
export class ResultCache {
  readonly dir: string;
  readonly enabled: boolean;
  constructor(root: string, enabled: boolean, dir: string = defaultCacheDir(root)) {
    this.enabled = enabled;
    this.dir = dir;
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
      const parsed: unknown = JSON.parse(readFileSync(join(this.dir, `${key}.json`), "utf8"));
      return isCacheEntry(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  put(key: string, entry: CacheEntry): void {
    if (!this.enabled) return;
    const tmp = join(
      this.dir,
      `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
    );
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(entry), { flag: "wx", mode: 0o600 });
      renameSync(tmp, join(this.dir, `${key}.json`)); // atomic: readers never see partial files
    } catch {
      // A cache write failure must never fail a scan, and neither may cleaning up after it.
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* nothing more to do */
      }
    }
  }
}
