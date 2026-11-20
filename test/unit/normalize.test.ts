import assert from "node:assert/strict";
import { after, test } from "node:test";
import { applyBaseline, loadBaseline, saveBaseline } from "../../src/core/baseline.ts";
import { ResultCache } from "../../src/core/cache.ts";
import { filterToChangedLines, sortFindings, toFindings } from "../../src/core/normalize.ts";
import type { Finding, RawFinding, ScanTarget } from "../../src/types.ts";
import { makeProject } from "../helpers.ts";

const p = makeProject({ "a.js": "const x = 1;\nconst  secret =   'abc';\n" }, { git: false });
after(() => p.cleanup());

const raw = (over: Partial<RawFinding> = {}): RawFinding => ({
  engine: "e",
  ruleId: "r",
  category: "sast",
  severity: "high",
  file: "a.js",
  line: 2,
  endLine: 2,
  message: "m",
  remediation: null,
  references: [],
  ...over,
});

test("fingerprint survives line shifts and whitespace changes but not content changes", () => {
  const before = toFindings([raw()], p.dir)[0] as Finding;
  p.write("a.js", "// new header\n\nconst x = 1;\nconst secret = 'abc';\n");
  const shifted = toFindings([raw({ line: 4 })], p.dir)[0] as Finding;
  assert.equal(shifted.fingerprint, before.fingerprint);
  p.write("a.js", "const x = 1;\nconst secret = 'different';\n");
  const changed = toFindings([raw()], p.dir)[0] as Finding;
  assert.notEqual(changed.fingerprint, before.fingerprint);
});

test("explicit key wins over source line; output never carries the key or source text", () => {
  const [f] = toFindings([raw({ key: "lodash@4.17.15#GHSA-1", line: null, endLine: null })], p.dir);
  assert.ok(f);
  assert.equal("key" in f, false);
  assert.equal(JSON.stringify(f).includes("secret"), false);
});

test("exact duplicates collapse; identical lines at different places get distinct identities", () => {
  p.write("a.js", "same\nsame\n");
  const out = toFindings([raw({ line: 1 }), raw({ line: 1 }), raw({ line: 2 })], p.dir);
  assert.equal(out.length, 2, "the same finding reported twice is one finding");
  assert.notEqual(out[0]?.fingerprint, out[1]?.fingerprint);
  // the first occurrence keeps the plain identity, so existing baselines stay valid
  const single = toFindings([raw({ line: 1 })], p.dir);
  assert.equal(out[0]?.fingerprint, single[0]?.fingerprint);
});

test("a baselined line cannot hide a newly added copy of the same line (verifier repro)", () => {
  p.write("a.js", "eval(userInput)\n");
  const before = toFindings([raw({ line: 1, endLine: 1 })], p.dir);
  const base = new Set(before.map((f) => f.fingerprint));
  p.write("a.js", "eval(userInput)\neval(userInput)\n");
  const after = toFindings([raw({ line: 1, endLine: 1 }), raw({ line: 2, endLine: 2 })], p.dir);
  assert.equal(after.length, 2);
  const fresh = after.filter((f) => !base.has(f.fingerprint));
  assert.equal(
    fresh.length,
    1,
    "the second copy is a new finding even though the baseline holds the first",
  );
  assert.equal(fresh[0]?.line, 2);
});

test("fingerprints are stable regardless of the order engines report findings", () => {
  p.write("a.js", "x\nx\nx\n");
  const fwd = toFindings([raw({ line: 1 }), raw({ line: 2 }), raw({ line: 3 })], p.dir).map(
    (f) => f.fingerprint,
  );
  const rev = toFindings([raw({ line: 3 }), raw({ line: 2 }), raw({ line: 1 })], p.dir).map(
    (f) => f.fingerprint,
  );
  assert.deepEqual([...fwd].sort(), [...rev].sort());
});

test("sorting: severity desc, then file, then line", () => {
  const f = toFindings(
    [
      raw({ severity: "low", line: 1, ruleId: "a" }),
      raw({ severity: "critical", file: "b.js", line: 1, ruleId: "b" }),
      raw({ severity: "high", line: 1, ruleId: "c" }),
    ],
    p.dir,
  );
  assert.deepEqual(
    sortFindings(f).map((x) => x.severity),
    ["critical", "high", "low"],
  );
});

const target = (over: Partial<ScanTarget> = {}): ScanTarget => ({
  root: p.dir,
  mode: "changed",
  ref: null,
  isGit: true,
  files: ["a.js"],
  changedLines: new Map([["a.js", [{ start: 10, end: 12 }]]]),
  excludedCount: 0,
  ...over,
});

test("line filter drops only SAST findings outside changed lines, and reports the count", () => {
  p.write("a.js", "x\n".repeat(30));
  const f = toFindings(
    [
      raw({ line: 11, endLine: 11 }),
      raw({ line: 3, endLine: 3, ruleId: "r2" }),
      raw({ line: 3, endLine: 3, ruleId: "r3", category: "secrets" }),
      raw({ line: null, endLine: null, ruleId: "r4" }),
      raw({ line: 9, endLine: 10, ruleId: "r5" }),
      raw({ line: 11, endLine: 2, ruleId: "r6" }),
    ],
    p.dir,
  );
  const { kept, suppressed } = filterToChangedLines(f, target(), true);
  assert.equal(suppressed, 1);
  assert.deepEqual(kept.map((x) => x.ruleId).sort(), ["r", "r3", "r4", "r5", "r6"]);
});

test("line filter is off for --all, when disabled, and for untracked files", () => {
  const f = toFindings([raw({ line: 3, endLine: 3 })], p.dir);
  assert.equal(filterToChangedLines(f, target({ mode: "all" }), true).suppressed, 0);
  assert.equal(filterToChangedLines(f, target(), false).suppressed, 0);
  assert.equal(filterToChangedLines(f, target({ changedLines: new Map() }), true).suppressed, 0);
});

test("baseline round-trips and suppresses known fingerprints only", () => {
  p.write("a.js", "x\n".repeat(5));
  const f = toFindings([raw({ line: 1 }), raw({ line: 2, ruleId: "other" })], p.dir);
  assert.equal(loadBaseline(p.dir, ".code-intel/baseline.json"), null);
  assert.equal(saveBaseline(p.dir, ".code-intel/baseline.json", f.slice(0, 1)), 1);
  const base = loadBaseline(p.dir, ".code-intel/baseline.json");
  const { kept, suppressed } = applyBaseline(f, base);
  assert.equal(suppressed, 1);
  assert.equal(kept[0]?.ruleId, "other");
});

test("cache: hit on identical inputs, miss when content, config or engine identity changes", () => {
  const c = new ResultCache(p.dir, true);
  p.write("a.js", "one\n");
  const k1 = ResultCache.key("e", "id1", ["cfg"], p.dir, ["a.js"]);
  assert.equal(c.get(k1), null);
  c.put(k1, { findings: [raw()], warnings: [] });
  assert.equal(c.get(k1)?.findings.length, 1);
  assert.equal(ResultCache.key("e", "id1", ["cfg"], p.dir, ["a.js"]), k1);
  assert.notEqual(ResultCache.key("e", "id2", ["cfg"], p.dir, ["a.js"]), k1);
  assert.notEqual(ResultCache.key("e", "id1", ["cfg2"], p.dir, ["a.js"]), k1);
  p.write("a.js", "two\n");
  assert.notEqual(ResultCache.key("e", "id1", ["cfg"], p.dir, ["a.js"]), k1);
  assert.equal(new ResultCache(p.dir, false).get(k1), null, "disabled cache never reads");
});
