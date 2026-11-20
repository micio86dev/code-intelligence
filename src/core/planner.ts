import type { Detection, Engine } from "../engines/engine.ts";
import { CATEGORIES, type Category, type ProfileName, type ScanTarget } from "../types.ts";
import { UsageError } from "./errors.ts";

export interface PlanEntry {
  /** Engine name, or the category name when no engine exists for that category. */
  name: string;
  category: Category;
  engine: Engine | null;
  /** What will happen: run it, skip it with a reason, or report it as unavailable. */
  action: "run" | "skip" | "unavailable";
  detection: Detection | null;
  files: string[];
  reason: string | null;
}

/** Expand selectors (category or engine names) into the categories to cover, plus pinned engines. */
export function resolveSelectors(
  selectors: readonly string[],
  engines: readonly Engine[],
): { categories: Category[]; pinned: Set<string> } {
  const cats = new Set<Category>();
  const pinned = new Set<string>();
  for (const s of selectors) {
    if ((CATEGORIES as readonly string[]).includes(s)) {
      cats.add(s as Category);
      continue;
    }
    const e = engines.find((x) => x.name === s);
    if (!e) {
      const known = [...CATEGORIES, ...engines.map((x) => x.name)].join(", ");
      throw new UsageError(`Unknown engine or category '${s}'`, [`Known: ${known}`]);
    }
    cats.add(e.category);
    pinned.add(e.name);
  }
  return { categories: CATEGORIES.filter((c) => cats.has(c)), pinned };
}

/**
 * For each requested category, walk its engines by priority and pick the first that has work
 * to do and is installed. Nothing is dropped silently: every category yields exactly one
 * entry that says run, skip (with why), or unavailable (with how to fix it).
 */
export async function plan(
  engines: readonly Engine[],
  selectors: readonly string[],
  target: ScanTarget,
  profile: ProfileName,
): Promise<PlanEntry[]> {
  const { categories, pinned } = resolveSelectors(selectors, engines);
  const entries: PlanEntry[] = [];

  for (const cat of categories) {
    let candidates = engines
      .filter((e) => e.category === cat)
      .sort((a, b) => a.priority - b.priority);
    const pins = candidates.filter((e) => pinned.has(e.name));
    if (pins.length > 0) candidates = pins;

    const skips: string[] = [];
    const missing: Array<{ engine: Engine; detection: Detection; files: string[] }> = [];
    let chosen: PlanEntry | null = null;

    for (const engine of candidates) {
      const sel = engine.select(target, profile);
      if (sel.files === null) {
        skips.push(sel.skipReason ?? "nothing to scan");
        continue;
      }
      // Locate only: reading versions spawns every tool (semgrep alone is ~0.5 s) and would delay all engines.
      const detection = await engine.detect({ withVersion: false });
      if (detection.available) {
        chosen = {
          name: engine.name,
          category: cat,
          engine,
          action: "run",
          detection,
          files: sel.files,
          reason: null,
        };
        break;
      }
      missing.push({ engine, detection, files: sel.files });
    }

    if (chosen) {
      entries.push(chosen);
    } else if (missing.length > 0) {
      const first = missing[0] as (typeof missing)[number];
      const hints = missing
        .map((m) => m.detection.reason)
        .filter(Boolean)
        .join(" | ");
      entries.push({
        name: first.engine.name,
        category: cat,
        engine: first.engine,
        action: "unavailable",
        detection: first.detection,
        files: first.files,
        reason: hints,
      });
    } else if (candidates.length === 0) {
      entries.push({
        name: cat,
        category: cat,
        engine: null,
        action: "skip",
        detection: null,
        files: [],
        reason: `no engine implemented for '${cat}'`,
      });
    } else {
      const first = candidates[0] as Engine;
      entries.push({
        name: first.name,
        category: cat,
        engine: first,
        action: "skip",
        detection: null,
        files: [],
        reason: skips[0] ?? "nothing to scan",
      });
    }
  }
  return entries;
}
