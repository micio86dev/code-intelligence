import assert from "node:assert/strict";
import { after, test } from "node:test";
import { runScan } from "../../src/commands/scan.ts";
import type { EngineFailure } from "../../src/core/errors.ts";
import { exec } from "../../src/core/exec.ts";
import { silentLogger } from "../../src/core/logger.ts";
import { plan } from "../../src/core/planner.ts";
import type { Detection, Engine, EngineOutput, RunContext } from "../../src/engines/engine.ts";
import { processFailure } from "../../src/engines/util.ts";
import type { RawFinding } from "../../src/types.ts";
import { makeProject } from "../helpers.ts";

const projects: Array<{ cleanup(): void }> = [];
after(() => {
  for (const p of projects) p.cleanup();
});
const project = (files: Record<string, string>) => {
  const p = makeProject(files);
  p.commit();
  projects.push(p);
  return p;
};

const finding = (over: Partial<RawFinding> = {}): RawFinding => ({
  engine: "fake",
  ruleId: "fake.rule",
  category: "sast",
  severity: "high",
  file: "a.js",
  line: 1,
  endLine: 1,
  message: "bad",
  remediation: null,
  references: [],
  ...over,
});

const present: Detection = {
  available: true,
  version: "1.0.0",
  binary: process.execPath,
  reason: null,
};

function fake(name: string, category: Engine["category"], over: Partial<Engine> = {}): Engine {
  return {
    name,
    category,
    priority: 0,
    binaryName: name,
    versionArgs: ["--version"],
    installHint: `install ${name}`,
    detect: async () => present,
    select: (t) => ({ files: t.files, skipReason: null }),
    cacheable: () => false,
    cacheInputs: () => [],
    run: async (): Promise<EngineOutput> => ({ findings: [], warnings: [] }),
    ...over,
  };
}

const base = (cwd: string, engineSet: Engine[], over: Record<string, unknown> = {}) => ({
  cwd,
  profile: "quick" as const,
  mode: "all" as const,
  ref: null,
  engines: null,
  failOn: null,
  timeoutMs: null,
  cache: false,
  newOnly: false,
  ignoreRepoConfig: false,
  allowMissing: false,
  log: silentLogger,
  engineSet,
  ...over,
});

test("missing engine => unavailable, scan incomplete (exit 3), never a pass", async () => {
  const p = project({ "a.js": "x\n" });
  const missing = fake("m", "secrets", {
    detect: async () => ({
      available: false,
      version: null,
      binary: null,
      reason: "not installed",
    }),
  });
  const { report } = await runScan(base(p.dir, [missing], { engines: ["secrets"] }));
  assert.equal(report.engines[0]?.status, "unavailable");
  assert.equal(report.complete, false);
  assert.equal(report.exitCode, 3);
});

test("--allow-missing keeps the status visible but completes the scan", async () => {
  const p = project({ "a.js": "x\n" });
  const missing = fake("m", "secrets", {
    detect: async () => ({
      available: false,
      version: null,
      binary: null,
      reason: "not installed",
    }),
  });
  const { report } = await runScan(
    base(p.dir, [missing], { engines: ["secrets"], allowMissing: true }),
  );
  assert.equal(report.engines[0]?.status, "unavailable");
  assert.equal(report.complete, true);
  assert.equal(report.exitCode, 0);
});

test("timeout: slow engine is killed, classified, and does not hide a fast engine's findings", async () => {
  const p = project({ "a.js": "x\n" });
  const slow = fake("slow", "secrets", {
    run: async (ctx: RunContext) => {
      const r = await exec(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        cwd: ctx.root,
        timeoutMs: ctx.timeoutMs,
      });
      const f = processFailure("slow", r, [0]);
      if (f) throw f;
      return { findings: [], warnings: [] };
    },
  });
  const fast = fake("fast", "sast", { run: async () => ({ findings: [finding()], warnings: [] }) });
  const t0 = Date.now();
  const { report } = await runScan(base(p.dir, [slow, fast], { timeoutMs: 1000 }));
  assert.ok(Date.now() - t0 < 8000);
  assert.equal(report.engines.find((e) => e.engine === "slow")?.status, "timeout");
  assert.equal(report.engines.find((e) => e.engine === "fast")?.status, "findings");
  assert.equal(report.exitCode, 1, "blocking findings still fail the run");
});

test("crash and garbage output are 'error', and the message never contains stdout", async () => {
  const p = project({ "a.js": "x\n" });
  const crash = fake("crash", "secrets", {
    run: async (ctx: RunContext) => {
      const r = await exec(
        process.execPath,
        ["-e", "console.log('TOPSECRETSTDOUT');console.error('boom');process.exit(9)"],
        { cwd: ctx.root, timeoutMs: 5000 },
      );
      throw processFailure("crash", r, [0]) as EngineFailure;
    },
  });
  const { report } = await runScan(base(p.dir, [crash], { engines: ["secrets"] }));
  const r = report.engines[0];
  assert.equal(r?.status, "error");
  assert.match(r?.reason ?? "", /code 9/);
  assert.equal((r?.reason ?? "").includes("TOPSECRETSTDOUT"), false);
  assert.equal(report.exitCode, 3);
});

test("unexpected exceptions become error results, not crashes", async () => {
  const p = project({ "a.js": "x\n" });
  const bad = fake("bad", "sast", {
    run: async () => {
      throw new TypeError("kaboom");
    },
  });
  const { report } = await runScan(base(p.dir, [bad], { engines: ["sast"] }));
  assert.equal(report.engines[0]?.status, "error");
  assert.equal(report.exitCode, 3);
});

test("planner: first available engine in a category wins; fallback used when primary is missing", async () => {
  const p = project({ "a.js": "x\n" });
  const primary = fake("primary", "deps", {
    detect: async () => ({ available: false, version: null, binary: null, reason: "no primary" }),
  });
  const secondary = fake("secondary", "deps", { priority: 1 });
  const { report } = await runScan(base(p.dir, [primary, secondary], { engines: ["deps"] }));
  assert.equal(report.engines.length, 1);
  assert.equal(report.engines[0]?.engine, "secondary");
  assert.equal(report.engines[0]?.status, "ok");
});

test("planner: no work in scope => skipped with a reason, not unavailable", async () => {
  const p = project({ "a.js": "x\n" });
  const e = fake("e", "deps", {
    detect: async () => ({ available: false, version: null, binary: null, reason: "missing" }),
    select: () => ({ files: null, skipReason: "no lockfile in scope" }),
  });
  const { report } = await runScan(base(p.dir, [e], { engines: ["deps"] }));
  assert.equal(report.engines[0]?.status, "skipped");
  assert.equal(report.engines[0]?.reason, "no lockfile in scope");
  assert.equal(report.exitCode, 0);
});

test("planner rejects unknown selectors with the list of valid ones", async () => {
  await assert.rejects(
    plan(
      [fake("a", "sast")],
      ["nope"],
      {
        root: "",
        mode: "all",
        ref: null,
        isGit: true,
        files: [],
        changedLines: new Map(),
        excludedCount: 0,
      },
      "quick",
    ),
    /Unknown engine or category 'nope'/,
  );
});

test("fail-on threshold decides exit code 1", async () => {
  const p = project({ "a.js": "x\n" });
  const e = fake("e", "sast", {
    run: async () => ({ findings: [finding({ severity: "medium" })], warnings: [] }),
  });
  assert.equal((await runScan(base(p.dir, [e]))).report.exitCode, 0, "medium < default high");
  assert.equal((await runScan(base(p.dir, [e], { failOn: "medium" }))).report.exitCode, 1);
});

test("result cache: second run is served from cache only when the engine declares itself cacheable", async () => {
  const p = project({ "a.js": "x\n" });
  let runs = 0;
  const e = fake("e", "secrets", {
    cacheable: () => true,
    run: async () => {
      runs += 1;
      return { findings: [finding({ category: "secrets" })], warnings: [] };
    },
  });
  const first = await runScan(base(p.dir, [e], { cache: true }));
  const second = await runScan(base(p.dir, [e], { cache: true }));
  assert.equal(runs, 1);
  assert.equal(first.report.engines[0]?.cached, false);
  assert.equal(second.report.engines[0]?.cached, true);
  assert.equal(second.report.findings.length, 1);
  p.write("a.js", "changed\n");
  await runScan(base(p.dir, [e], { cache: true }));
  assert.equal(runs, 2, "content change invalidates");
  const nc = fake("nc", "deps", {
    cacheable: () => false,
    run: async () => {
      runs += 1;
      return { findings: [], warnings: [] };
    },
  });
  await runScan(base(p.dir, [nc], { cache: true, engines: ["deps"] }));
  await runScan(base(p.dir, [nc], { cache: true, engines: ["deps"] }));
  assert.equal(runs, 4, "non-cacheable engines always run");
});

test("a category with no engine is an explicit skip, never a crash or a silent pass", async () => {
  const p = project({ "a.js": "x\n" });
  const { report } = await runScan(
    base(p.dir, [fake("only-sast", "sast")], { engines: ["sast", "architecture"] }),
  );
  const arch = report.engines.find((e) => e.engine === "architecture");
  assert.equal(arch?.status, "skipped");
  assert.match(arch?.reason ?? "", /no engine implemented/);
  assert.equal(report.exitCode, 0);
});

test("engine error details: python tracebacks report the exception, and absolute paths are scrubbed", async () => {
  const { errorDetail, scrubPaths } = await import("../../src/engines/util.ts");
  const tb = [
    "Traceback (most recent call last):",
    '  File "/Users/someone/.local/lib/python3.12/site-packages/semgrep/cli.py", line 10, in main',
    "PermissionError: [Errno 1] Operation not permitted: '/Users/someone/.semgrep/settings.yml'",
  ].join("\n");
  const d = errorDetail(tb);
  assert.match(d, /PermissionError: \[Errno 1\] Operation not permitted/);
  assert.equal(d.includes("someone"), false);
  assert.equal(d.includes("/Users"), false);
  assert.equal(errorDetail("boom: bad config\nsecond line"), "boom: bad config");
  assert.equal(errorDetail(""), "no error output");
  assert.equal(scrubPaths("open C:\\Users\\bob\\x\\y.txt failed"), "open <path> failed");
  assert.equal(
    scrubPaths("rules at /etc/semgrep/rules.yml and ./relative"),
    "rules at <path> and ./relative",
  );
});

test("error details skip runtime boilerplate headers (node and python) and report the exception line", async () => {
  const { errorDetail } = await import("../../src/engines/util.ts");
  const nodeErr = [
    "node:internal/process/promises:394",
    "    triggerUncaughtException(err, true /* fromPromise */);",
    "    ^",
    "",
    "TypeError: ts.parseConfigFileTextToJson is not a function",
    "    at TSConfigPreprocessor.rewriteTSConfigFile (file:///x/y.js:46:39)",
  ].join("\n");
  assert.equal(errorDetail(nodeErr), "TypeError: ts.parseConfigFileTextToJson is not a function");
  assert.equal(errorDetail("Error: simple failure\nsecond"), "Error: simple failure");
  assert.equal(errorDetail("node:internal/x:1\nno exception line\nlast words"), "last words");
});

test("error details prefer the line that names the failure over an informational first line (osv-scanner)", async () => {
  const { errorDetail } = await import("../../src/engines/util.ts");
  // Real osv-scanner stderr for an unparseable package-lock.json: the first lines are progress logs.
  const osv = [
    "Scanning dir .",
    "Starting filesystem walk for root: /",
    "End status: 1 dirs visited, 3 inodes visited, 1 Extract calls, 144.916µs elapsed, 144µs wall time",
    "Error during extraction: (extracting as javascript/packagelockjson) work/package-lock.json: could not extract: unexpected end of JSON input",
    "No package sources found, --help for usage information.",
  ].join("\n");
  const d = errorDetail(osv);
  assert.match(d, /could not extract: unexpected end of JSON input/);
  assert.equal(d.includes("filesystem walk"), false);
  // Unchanged behavior: a first line that already names the problem stays the message, and without any
  // error-looking line the first line is still used.
  assert.equal(errorDetail("boom: bad config\nsecond line"), "boom: bad config");
  assert.equal(errorDetail("Scanning dir .\nall quiet"), "Scanning dir .");
});

test("planning only locates binaries: versions are read concurrently with the engine run, not before it", async () => {
  const detectCalls: Array<{ withVersion?: boolean } | undefined> = [];
  const slowVersion = fake("slowv", "secrets", {
    versionArgs: ["-e", "setTimeout(() => console.log('9.8.7'), 700)"],
    detect: async (opts) => {
      detectCalls.push(opts);
      return {
        available: true,
        version: opts?.withVersion === false ? null : "from-detect",
        binary: process.execPath,
        reason: null,
      };
    },
    run: async () => {
      await new Promise((r) => setTimeout(r, 800)); // the engine itself takes about as long as the version lookup
      return { findings: [], warnings: [] };
    },
  });
  const p = project({ "a.js": "x\n" });
  const t0 = performance.now();
  const { report } = await runScan(base(p.dir, [slowVersion], { engines: ["secrets"] }));
  const elapsed = performance.now() - t0;
  assert.deepEqual(detectCalls, [{ withVersion: false }], "the planner must not ask for versions");
  assert.equal(report.engines[0]?.version, "9.8.7", "the version is still reported");
  assert.ok(
    elapsed < 1400,
    `version lookup and engine run must overlap (took ${Math.round(elapsed)}ms; serial would be ~1500ms+)`,
  );
});

test("a cache hit reports the stored version without spawning the tool", async () => {
  const p = project({ "a.js": "x\n" });
  let versionSpawns = 0;
  const e = fake("vcache", "secrets", {
    cacheable: () => true,
    versionArgs: ["-e", "console.log('3.2.1')"],
    detect: async () => ({
      available: true,
      version: null,
      binary: process.execPath,
      reason: null,
    }),
    run: async () => {
      versionSpawns += 1;
      return { findings: [], warnings: [] };
    },
  });
  const first = await runScan(base(p.dir, [e], { cache: true, engines: ["secrets"] }));
  assert.equal(first.report.engines[0]?.version, "3.2.1");
  const second = await runScan(base(p.dir, [e], { cache: true, engines: ["secrets"] }));
  assert.equal(second.report.engines[0]?.cached, true);
  assert.equal(second.report.engines[0]?.version, "3.2.1", "version comes from the cache entry");
  assert.equal(versionSpawns, 1);
});

test("an engine that fails still reports its version", async () => {
  const p = project({ "a.js": "x\n" });
  const e = fake("vfail", "sast", {
    versionArgs: ["-e", "console.log('5.5.5')"],
    detect: async () => ({
      available: true,
      version: null,
      binary: process.execPath,
      reason: null,
    }),
    run: async () => {
      throw new Error("kaboom");
    },
  });
  const { report } = await runScan(base(p.dir, [e], { engines: ["sast"] }));
  assert.equal(report.engines[0]?.status, "error");
  assert.equal(report.engines[0]?.version, "5.5.5");
});
