import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { runInit } from "../../src/commands/init.ts";
import { applyBaseline, loadBaseline, saveBaseline } from "../../src/core/baseline.ts";
import { isCacheEntry, ResultCache } from "../../src/core/cache.ts";
import { loadConfig, validateConfig } from "../../src/core/config.ts";
import { UsageError } from "../../src/core/errors.ts";
import { safeWrite, UnsafePathError } from "../../src/core/safefs.ts";
import { makeProject } from "../helpers.ts";

const projects: Array<{ cleanup(): void }> = [];
after(() => {
  for (const p of projects) p.cleanup();
});
const mk = (files: Record<string, string> = {}, git = false) => {
  const p = makeProject(files, { git });
  projects.push(p);
  return p;
};
const skipWin = { skip: process.platform === "win32" };

test(
  "safeWrite refuses to write through a symlinked directory or file (verifier repro b)",
  skipWin,
  () => {
    const victim = mk({ "precious.txt": "victim data" });
    const p = mk();
    symlinkSync(victim.dir, join(p.dir, "out"));
    assert.throws(() => safeWrite(p.dir, "out/pwn.json", "x"), UnsafePathError);
    assert.equal(existsSync(join(victim.dir, "pwn.json")), false);
    // a symlinked final component is never written through either
    symlinkSync(join(victim.dir, "precious.txt"), join(p.dir, "link.txt"));
    assert.throws(() => safeWrite(p.dir, "link.txt", "x"), UnsafePathError);
    assert.equal(readFileSync(join(victim.dir, "precious.txt"), "utf8"), "victim data");
    safeWrite(p.dir, "plain/dir/file.txt", "ok");
    assert.equal(readFileSync(join(p.dir, "plain/dir/file.txt"), "utf8"), "ok");
  },
);

test(
  "a committed symlink in .code-intel/cache cannot make a scan truncate a file elsewhere (verifier repro a)",
  skipWin,
  () => {
    const victim = mk({ "precious.txt": "victim data" });
    const p = mk();
    mkdirSync(join(p.dir, ".code-intel/cache"), { recursive: true });
    symlinkSync(join(victim.dir, "precious.txt"), join(p.dir, ".code-intel/cache/.gitignore"));
    const cache = new ResultCache(p.dir, true);
    cache.put("abc", { findings: [], warnings: [] }); // must not throw and must not write through the link
    assert.equal(readFileSync(join(victim.dir, "precious.txt"), "utf8"), "victim data");
    assert.equal(
      readFileSync(join(p.dir, ".code-intel/cache/abc.json"), "utf8"),
      '{"findings":[],"warnings":[]}',
    );
    // a symlinked .code-intel directory disables caching instead of writing outside
    const p2 = mk();
    symlinkSync(victim.dir, join(p2.dir, ".code-intel"));
    new ResultCache(p2.dir, true).put("abc", { findings: [], warnings: [] });
    assert.equal(existsSync(join(victim.dir, "cache")), false);
  },
);

test("baseline writes refuse symlinks and .git targets (verifier repro b, c)", skipWin, () => {
  const victim = mk();
  const p = mk({ ".git/config": "[core]\n" });
  symlinkSync(victim.dir, join(p.dir, "out"));
  assert.throws(() => saveBaseline(p.dir, "out/pwn.json", []), UsageError);
  assert.equal(existsSync(join(victim.dir, "pwn.json")), false);
  const { issues } = validateConfig({ baseline: ".git/config" });
  assert.equal(issues[0]?.path, "baseline");
  assert.match(issues[0]?.message ?? "", /must not point into \.git/);
  assert.equal(validateConfig({ baseline: ".code-intel.json" }).issues.length, 1);
  assert.equal(validateConfig({ baseline: ".code-intel/baseline.json" }).issues.length, 0);
  assert.equal(readFileSync(join(p.dir, ".git/config"), "utf8"), "[core]\n");
});

test("a symlinked baseline is refused on read; a normal round trip still works", skipWin, () => {
  const victim = mk({ "other.json": '{"schemaVersion":1,"entries":[]}' });
  const p = mk();
  mkdirSync(join(p.dir, ".code-intel"));
  symlinkSync(join(victim.dir, "other.json"), join(p.dir, ".code-intel/baseline.json"));
  assert.throws(() => loadBaseline(p.dir, ".code-intel/baseline.json"), UsageError);
  const q = mk();
  assert.equal(saveBaseline(q.dir, ".code-intel/baseline.json", []), 0);
  assert.equal(applyBaseline([], loadBaseline(q.dir, ".code-intel/baseline.json")).kept.length, 0);
});

test("init never writes through a dangling symlink (verifier repro d)", skipWin, async () => {
  const victim = mk();
  const target = join(victim.dir, "created-by-init.txt");
  const p = mk();
  symlinkSync(target, join(p.dir, ".code-intel.json")); // dangling: existsSync() says it does not exist
  await assert.rejects(runInit(p.dir), UsageError);
  assert.equal(existsSync(target), false);
  const q = mk();
  mkdirSync(join(q.dir, ".code-intel"));
  symlinkSync(join(victim.dir, "gi.txt"), join(q.dir, ".code-intel/.gitignore"));
  const r = await runInit(q.dir);
  assert.deepEqual(r.created, [".code-intel.json"], "the dangling .gitignore link is left alone");
  assert.equal(existsSync(join(victim.dir, "gi.txt")), false);
});

test(
  "a symlinked or malformed .code-intel.json never leaks file contents in the error",
  skipWin,
  () => {
    const secret = mk({ id_rsa: "-----BEGIN SECRET-----\nsuper-sensitive-material\n" });
    const p = mk();
    symlinkSync(join(secret.dir, "id_rsa"), join(p.dir, ".code-intel.json"));
    try {
      loadConfig(p.dir, []);
      assert.fail("must throw");
    } catch (e) {
      assert.ok(e instanceof UsageError);
      assert.equal(
        `${(e as Error).message}${(e as UsageError).details.join()}`.includes("SECRET"),
        false,
      );
    }
    const q = mk();
    writeFileSync(join(q.dir, ".code-intel.json"), '{\n  "failOn": "high",\n  oops-token-xyz\n}');
    try {
      loadConfig(q.dir, []);
      assert.fail("must throw");
    } catch (e) {
      const msg = `${(e as Error).message}${(e as UsageError).details.join()}`;
      assert.match(msg, /not valid JSON \(line 3, column 3\)/);
      assert.equal(msg.includes("oops-token-xyz"), false, "report the position, never the text");
    }
  },
);

test("cache entries are validated: a forged 'no findings' entry shape or junk is a miss (verifier repro)", () => {
  assert.equal(isCacheEntry({ findings: [], warnings: [] }), true);
  assert.equal(isCacheEntry({ warnings: [] }), false);
  assert.equal(isCacheEntry({ findings: "x", warnings: [] }), false);
  assert.equal(isCacheEntry({ findings: [{ engine: "e" }], warnings: [] }), false);
  assert.equal(
    isCacheEntry({
      findings: [
        {
          engine: "e",
          ruleId: "r",
          category: "sast",
          severity: "high",
          file: "/etc/passwd",
          line: 1,
          endLine: 1,
          message: "m",
          remediation: null,
          references: [],
        },
      ],
      warnings: [],
    }),
    false,
    "an absolute file path is rejected",
  );
  const p = mk({ "a.js": "x\n" });
  const key = ResultCache.key("e", "id", [], p.dir, ["a.js"]);
  mkdirSync(join(p.dir, ".code-intel/cache"), { recursive: true });
  writeFileSync(join(p.dir, ".code-intel/cache", `${key}.json`), '{"warnings":[]}');
  assert.equal(
    new ResultCache(p.dir, true).get(key),
    null,
    "malformed entry is a miss, not a crash",
  );
});

test("the cache key is bound to the repository, so a committed cache from elsewhere never matches", () => {
  const a = mk({ "a.js": "same\n" });
  const b = mk({ "a.js": "same\n" });
  assert.notEqual(
    ResultCache.key("e", "id", [], a.dir, ["a.js"]),
    ResultCache.key("e", "id", [], b.dir, ["a.js"]),
  );
});
