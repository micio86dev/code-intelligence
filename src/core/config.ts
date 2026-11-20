import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { CATEGORIES, isSeverity, PROFILES, type ProfileName, type Severity } from "../types.ts";
import { UsageError } from "./errors.ts";
import {
  globProblem,
  isSafeGlob,
  MAX_PATTERNS,
  MAX_TOTAL_ALTERNATIVES,
  totalAlternatives,
} from "./glob.ts";
import { isSymlink } from "./safefs.ts";

export const CONFIG_FILE = ".code-intel.json";

export interface ProfileConfig {
  /** Engine names or category names (secrets, sast, deps, architecture). */
  engines: string[];
  timeoutMs: number;
}

export interface Config {
  failOn: Severity;
  exclude: string[];
  allowMissingEngines: boolean;
  baseline: string;
  /** True when --ignore-repo-config discarded the repository's own configuration. */
  repoConfigIgnored: boolean;
  /** In changed-file scans, drop SAST findings on lines the change did not touch. */
  lineFilter: boolean;
  profiles: Record<ProfileName, ProfileConfig>;
  engines: {
    gitleaks: { configPath: string | null };
    semgrep: { configs: string[] };
  };
}

export const DEFAULT_EXCLUDE = [
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".code-intel",
  "*.min.js",
  "*.map",
];

export function defaultConfig(): Config {
  return {
    failOn: "high",
    exclude: [...DEFAULT_EXCLUDE],
    allowMissingEngines: false,
    baseline: ".code-intel/baseline.json",
    lineFilter: true,
    repoConfigIgnored: false,
    profiles: {
      quick: { engines: ["secrets", "sast", "deps"], timeoutMs: 60_000 },
      deep: { engines: ["secrets", "sast", "deps", "architecture"], timeoutMs: 600_000 },
    },
    engines: {
      gitleaks: { configPath: null },
      semgrep: { configs: ["p/default"] },
    },
  };
}

type Issue = { path: string; message: string };

const ROOT_KEYS = new Set([
  "$schema",
  "failOn",
  "exclude",
  "allowMissingEngines",
  "baseline",
  "lineFilter",
  "profiles",
  "engines",
]);
const REGISTRY_RE = /^[pr]\/[A-Za-z0-9_.\-/]+$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A repo-relative path that stays inside the repo (no absolute, no `..`). */
function isRepoRelative(p: string): boolean {
  // Reject URLs / drive prefixes ("https://...", "C:\..."), NUL bytes, absolute and `..` paths.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p);
  return p.length > 0 && !hasScheme && isSafeGlob(p) && !p.includes("\0");
}

/** Paths the tool must never write: git internals and its own configuration. */
function isProtectedPath(p: string): boolean {
  // Normalize first, then compare case-insensitively: `.//.git/config`, `a/../.git/config` and `.GIT/config`
  // (a case-insensitive file system) all resolve into git's own directory.
  const parts = posix
    .normalize(p.replace(/\\/g, "/"))
    .split("/")
    .filter((x) => x && x !== ".");
  if (parts.some((x) => x.toLowerCase() === ".git")) return true;
  return parts.join("/").toLowerCase() === CONFIG_FILE.toLowerCase();
}

function strArray(v: unknown, path: string, issues: Issue[]): string[] | null {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    issues.push({ path, message: "must be an array of strings" });
    return null;
  }
  return v as string[];
}

export function validateConfig(raw: unknown): { config: Config; issues: Issue[] } {
  const issues: Issue[] = [];
  const cfg = defaultConfig();
  if (!isObj(raw)) {
    return { config: cfg, issues: [{ path: "$", message: "config must be a JSON object" }] };
  }
  for (const k of Object.keys(raw)) {
    if (!ROOT_KEYS.has(k)) issues.push({ path: k, message: "unknown key" });
  }

  if (raw.failOn !== undefined) {
    if (isSeverity(raw.failOn)) cfg.failOn = raw.failOn;
    else
      issues.push({ path: "failOn", message: "must be one of info, low, medium, high, critical" });
  }
  if (raw.exclude !== undefined) {
    const arr = strArray(raw.exclude, "exclude", issues);
    if (arr) {
      if (arr.length > MAX_PATTERNS) {
        issues.push({ path: "exclude", message: `must have at most ${MAX_PATTERNS} entries` });
      }
      if (totalAlternatives(arr) > MAX_TOTAL_ALTERNATIVES) {
        issues.push({
          path: "exclude",
          message: `patterns may expand to at most ${MAX_TOTAL_ALTERNATIVES} alternatives in total (brace groups multiply)`,
        });
      }
      arr.forEach((g, i) => {
        const problem = globProblem(g);
        if (problem) issues.push({ path: `exclude[${i}]`, message: problem });
      });
      cfg.exclude = [...DEFAULT_EXCLUDE, ...arr];
    }
  }
  if (raw.allowMissingEngines !== undefined) {
    if (typeof raw.allowMissingEngines === "boolean")
      cfg.allowMissingEngines = raw.allowMissingEngines;
    else issues.push({ path: "allowMissingEngines", message: "must be a boolean" });
  }
  if (raw.lineFilter !== undefined) {
    if (typeof raw.lineFilter === "boolean") cfg.lineFilter = raw.lineFilter;
    else issues.push({ path: "lineFilter", message: "must be a boolean" });
  }
  if (raw.baseline !== undefined) {
    if (typeof raw.baseline !== "string" || !isRepoRelative(raw.baseline)) {
      issues.push({ path: "baseline", message: "must be a repo-relative path without '..'" });
    } else if (isProtectedPath(raw.baseline)) {
      issues.push({
        path: "baseline",
        message: "must not point into .git or at the configuration file",
      });
    } else cfg.baseline = raw.baseline;
  }

  if (raw.profiles !== undefined) {
    if (!isObj(raw.profiles)) {
      issues.push({ path: "profiles", message: "must be an object" });
    } else {
      for (const [name, p] of Object.entries(raw.profiles)) {
        if (!(PROFILES as readonly string[]).includes(name)) {
          issues.push({
            path: `profiles.${name}`,
            message: "unknown profile (expected quick or deep)",
          });
          continue;
        }
        if (!isObj(p)) {
          issues.push({ path: `profiles.${name}`, message: "must be an object" });
          continue;
        }
        const target = cfg.profiles[name as ProfileName];
        for (const k of Object.keys(p)) {
          if (k !== "engines" && k !== "timeoutMs") {
            issues.push({ path: `profiles.${name}.${k}`, message: "unknown key" });
          }
        }
        if (p.engines !== undefined) {
          const arr = strArray(p.engines, `profiles.${name}.engines`, issues);
          if (arr) target.engines = arr;
        }
        if (p.timeoutMs !== undefined) {
          if (
            Number.isInteger(p.timeoutMs) &&
            (p.timeoutMs as number) >= 1000 &&
            (p.timeoutMs as number) <= 3_600_000
          ) {
            target.timeoutMs = p.timeoutMs as number;
          } else {
            issues.push({
              path: `profiles.${name}.timeoutMs`,
              message: "must be an integer between 1000 and 3600000",
            });
          }
        }
      }
    }
  }

  if (raw.engines !== undefined) {
    if (!isObj(raw.engines)) {
      issues.push({ path: "engines", message: "must be an object" });
    } else {
      for (const [name, e] of Object.entries(raw.engines)) {
        if (name !== "gitleaks" && name !== "semgrep") {
          issues.push({ path: `engines.${name}`, message: "unknown engine config" });
          continue;
        }
        if (!isObj(e)) {
          issues.push({ path: `engines.${name}`, message: "must be an object" });
          continue;
        }
        if (name === "gitleaks") {
          for (const k of Object.keys(e)) {
            if (k !== "configPath")
              issues.push({ path: `engines.gitleaks.${k}`, message: "unknown key" });
          }
          if (e.configPath !== undefined) {
            if (typeof e.configPath === "string" && isRepoRelative(e.configPath)) {
              cfg.engines.gitleaks.configPath = e.configPath;
            } else {
              issues.push({
                path: "engines.gitleaks.configPath",
                message: "must be a repo-relative path without '..'",
              });
            }
          }
        } else {
          for (const k of Object.keys(e)) {
            if (k !== "configs")
              issues.push({ path: `engines.semgrep.${k}`, message: "unknown key" });
          }
          if (e.configs !== undefined) {
            const arr = strArray(e.configs, "engines.semgrep.configs", issues);
            if (arr) {
              arr.forEach((c, i) => {
                if (!REGISTRY_RE.test(c) && !isRepoRelative(c)) {
                  issues.push({
                    path: `engines.semgrep.configs[${i}]`,
                    message: "must be a registry id like 'p/default' or a repo-relative path",
                  });
                } else if (c.startsWith("-")) {
                  issues.push({
                    path: `engines.semgrep.configs[${i}]`,
                    message: "must not start with '-'",
                  });
                }
              });
              if (arr.length === 0) {
                issues.push({ path: "engines.semgrep.configs", message: "must not be empty" });
              } else {
                cfg.engines.semgrep.configs = arr;
              }
            }
          }
        }
      }
    }
  }

  return { config: cfg, issues };
}

/** Category or engine names accepted in profile.engines / --engines. */
export function isKnownSelector(s: string, engineNames: readonly string[]): boolean {
  return (CATEGORIES as readonly string[]).includes(s) || engineNames.includes(s);
}

export function loadConfig(
  root: string,
  engineNames: readonly string[],
  opts: { ignoreRepoConfig?: boolean } = {},
): Config {
  if (opts.ignoreRepoConfig) return { ...defaultConfig(), repoConfigIgnored: true };
  const file = join(root, CONFIG_FILE);
  // A committed symlink could point at any file on the machine and parse errors echo file contents.
  if (isSymlink(file)) throw new UsageError(`Refusing to read ${CONFIG_FILE}: it is a symlink`);
  if (!existsSync(file)) return defaultConfig();
  let parsed: unknown;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
    parsed = JSON.parse(text);
  } catch (e) {
    // Report where, never what: the parser's message quotes the offending text.
    const m = /position (\d+)/.exec((e as Error).message);
    const upTo = m ? text.slice(0, Number(m[1])).split("\n") : [];
    const where = m ? ` (line ${upTo.length}, column ${(upTo.at(-1)?.length ?? 0) + 1})` : "";
    throw new UsageError(`Invalid ${CONFIG_FILE}: not valid JSON${where}`);
  }
  const { config, issues } = validateConfig(parsed);
  for (const [name, p] of Object.entries(config.profiles)) {
    p.engines.forEach((s, i) => {
      if (!isKnownSelector(s, engineNames)) {
        issues.push({
          path: `profiles.${name}.engines[${i}]`,
          message: `unknown engine or category '${s}'`,
        });
      }
    });
  }
  if (issues.length > 0) {
    throw new UsageError(
      `Invalid ${CONFIG_FILE}`,
      issues.map((i) => `${i.path}: ${i.message}`),
    );
  }
  return config;
}

/**
 * What the repository's configuration changed compared to the defaults. A scan of a repository you do not
 * control can be quietly neutralized by its own config (everything excluded, a catch-all allowlist, a high
 * failing threshold), so the report always says when non-default settings are in effect.
 */
export function describeNonDefaults(cfg: Config): string[] {
  const d = defaultConfig();
  const out: string[] = [];
  if (cfg.failOn !== d.failOn) out.push(`failOn=${cfg.failOn}`);
  const extra = cfg.exclude.filter((e, i) => e !== d.exclude[i]);
  if (extra.length > 0) {
    out.push(
      `${extra.length} extra exclude pattern(s): ${extra.slice(0, 3).join(", ")}${extra.length > 3 ? ", ..." : ""}`,
    );
  }
  if (cfg.allowMissingEngines) out.push("allowMissingEngines=true");
  if (!cfg.lineFilter) out.push("lineFilter=false");
  if (cfg.baseline !== d.baseline) out.push(`baseline=${cfg.baseline}`);
  for (const name of Object.keys(cfg.profiles) as Array<keyof Config["profiles"]>) {
    if (JSON.stringify(cfg.profiles[name]) !== JSON.stringify(d.profiles[name]))
      out.push(`profiles.${name} customized`);
  }
  if (JSON.stringify(cfg.engines) !== JSON.stringify(d.engines))
    out.push("engine settings customized");
  return out;
}
