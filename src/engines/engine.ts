import type { Config } from "../core/config.ts";
import type { Logger } from "../core/logger.ts";
import type { Category, ProfileName, RawFinding, ScanTarget, TargetMode } from "../types.ts";

export interface Detection {
  available: boolean;
  version: string | null;
  /** Absolute path of the binary when found. */
  binary: string | null;
  reason: string | null;
}

export interface Selection {
  /** Files to hand to the engine; null together with skipReason means "do not run". */
  files: string[] | null;
  skipReason: string | null;
}

export interface RunContext {
  root: string;
  files: string[];
  /** Scope of the scan; `all` lets engines walk the repository with their own native ignore rules. */
  mode: TargetMode;
  /** Config exclude globs, for engines that walk the tree themselves. */
  exclude: readonly string[];
  config: Config;
  timeoutMs: number;
  binary: string;
  log: Logger;
}

export interface EngineOutput {
  findings: RawFinding[];
  warnings: string[];
  /** Version learned while running, when `--version` is not available. */
  version?: string;
}

export interface Engine {
  readonly name: string;
  readonly category: Category;
  /** Lower runs first when several engines serve the same category (fallback order). */
  readonly priority: number;
  readonly binaryName: string;
  readonly installHint: string;
  detect(): Promise<Detection>;
  select(target: ScanTarget, profile: ProfileName): Selection;
  /** True only when results are a pure function of file contents + engine + config. */
  cacheable(config: Config): boolean;
  /** Config values that influence results; part of the cache key. */
  cacheInputs(config: Config, root: string): string[];
  run(ctx: RunContext): Promise<EngineOutput>;
}

export const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "requirements.txt",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "Cargo.lock",
  "go.mod",
  "composer.lock",
  "Gemfile.lock",
  "pom.xml",
  "gradle.lockfile",
  "pubspec.lock",
  "mix.lock",
]);

export function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

export function isLockfile(p: string): boolean {
  return LOCKFILES.has(basename(p));
}
