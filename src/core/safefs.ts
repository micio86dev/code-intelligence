import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { isSafeGlob } from "./glob.ts";

/** Thrown when a write would go through a symlink or outside the repository. */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/** lstat-based existence: true for a dangling symlink too (existsSync follows links and says false). */
export function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Refuse a repo-relative path if it is not a plain relative path, or if any component that already
 * exists is a symlink. A hostile repository can commit `out -> /somewhere/else` and a lexical check
 * alone would happily write through it.
 */
export function assertPlainPath(root: string, rel: string): void {
  if (!rel || rel.includes("\0") || !isSafeGlob(rel)) {
    throw new UnsafePathError(`'${rel}' is not a plain repository-relative path`);
  }
  let cur = root;
  for (const part of rel.split("/").filter(Boolean)) {
    cur = join(cur, part);
    if (isSymlink(cur)) throw new UnsafePathError(`refusing to write through a symlink: ${rel}`);
  }
}

/**
 * Write a file inside the repository without ever following a link: components are checked, the data is
 * written to a fresh temporary file in the same directory, and renamed over the target. A rename replaces
 * a symlink at the target instead of writing through it.
 */
export function safeWrite(root: string, rel: string, data: string): void {
  assertPlainPath(root, rel);
  const target = join(root, rel);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  assertPlainPath(root, rel); // re-check after mkdir: nothing may have turned into a link in between
  try {
    if (lstatSync(target).isDirectory()) throw new UnsafePathError(`${rel} is a directory`);
  } catch (e) {
    if (e instanceof UnsafePathError) throw e;
  }
  const tmp = join(dir, `.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** True only for a regular file (not a link) whose real location is inside the repository. */
export function isPlainFileInside(root: string, rel: string): boolean {
  try {
    const abs = join(root, rel);
    if (!lstatSync(abs).isFile()) return false;
    const realRoot = realpathSync.native(root);
    const real = realpathSync.native(abs);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}
