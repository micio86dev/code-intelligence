import { availableParallelism } from "node:os";
import type { Engine, EngineOutput, RunContext } from "../engines/engine.ts";
import type { EngineResult, EngineStatus, RawFinding, TargetMode } from "../types.ts";
import { ResultCache } from "./cache.ts";
import type { Config } from "./config.ts";
import { EngineFailure } from "./errors.ts";
import type { Logger } from "./logger.ts";
import type { PlanEntry } from "./planner.ts";

export interface RunSettings {
  root: string;
  config: Config;
  mode: TargetMode;
  timeoutMs: number;
  cache: ResultCache;
  log: Logger;
  /** Max engines running at once. Defaults to the CPU count. */
  concurrency?: number;
}

async function pool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

const emptyResult = (e: PlanEntry, status: EngineStatus, reason: string | null): EngineResult => ({
  engine: e.name,
  category: e.category,
  version: e.detection?.version ?? null,
  status,
  reason,
  warnings: [],
  durationMs: 0,
  findingCount: 0,
  cached: false,
  filesScanned: null,
});

async function runOne(
  entry: PlanEntry,
  s: RunSettings,
): Promise<{ result: EngineResult; findings: RawFinding[] }> {
  if (entry.action === "skip")
    return { result: emptyResult(entry, "skipped", entry.reason), findings: [] };
  if (entry.action === "unavailable") {
    return { result: emptyResult(entry, "unavailable", entry.reason), findings: [] };
  }

  const engine = entry.engine as Engine; // action === "run" always carries an engine
  const binary = entry.detection?.binary ?? engine.binaryName;
  const started = performance.now();
  const base = emptyResult(entry, "ok", null);
  base.filesScanned = entry.files.length;

  const useCache = engine.cacheable(s.config) && s.cache.enabled;
  const key = useCache
    ? ResultCache.key(
        engine.name,
        ResultCache.binaryIdentity(binary),
        engine.cacheInputs(s.config),
        s.root,
        entry.files,
      )
    : "";
  if (useCache) {
    const hit = s.cache.get(key);
    if (hit) {
      s.log.debug("cache hit", { engine: engine.name });
      return {
        result: {
          ...base,
          status: hit.findings.length ? "findings" : "ok",
          warnings: hit.warnings,
          findingCount: hit.findings.length,
          cached: true,
          durationMs: Math.round(performance.now() - started),
        },
        findings: hit.findings,
      };
    }
  }

  const ctx: RunContext = {
    root: s.root,
    files: entry.files,
    mode: s.mode,
    exclude: s.config.exclude,
    config: s.config,
    timeoutMs: s.timeoutMs,
    binary,
    log: s.log,
  };
  try {
    const out: EngineOutput = await engine.run(ctx);
    if (useCache) s.cache.put(key, { findings: out.findings, warnings: out.warnings });
    return {
      result: {
        ...base,
        version: out.version ?? base.version,
        status: out.findings.length ? "findings" : "ok",
        warnings: out.warnings,
        findingCount: out.findings.length,
        durationMs: Math.round(performance.now() - started),
      },
      findings: out.findings,
    };
  } catch (e) {
    const failure = e instanceof EngineFailure ? e : null;
    s.log.debug("engine failed", {
      engine: engine.name,
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
    return {
      result: {
        ...base,
        status: failure?.kind ?? "error",
        reason: failure
          ? failure.message
          : `${engine.name}: unexpected error (${e instanceof Error ? e.message : String(e)})`,
        durationMs: Math.round(performance.now() - started),
      },
      findings: [],
    };
  }
}

/** Run planned engines concurrently. One engine failing never aborts or hides the others. */
export async function runPlan(
  entries: readonly PlanEntry[],
  s: RunSettings,
): Promise<{ results: EngineResult[]; findings: RawFinding[] }> {
  const parallel = s.concurrency ?? availableParallelism();
  const settled = await pool(entries, parallel, (e) => runOne(e, s));
  return { results: settled.map((x) => x.result), findings: settled.flatMap((x) => x.findings) };
}
