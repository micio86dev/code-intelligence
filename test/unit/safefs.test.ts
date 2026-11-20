import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { runInit } from "../../src/commands/init.ts";
import { applyBaseline, loadBaseline, saveBaseline } from "../../src/core/baseline.ts";
import { defaultCacheDir, isCacheEntry, ResultCache } from "../../src/core/cache.ts";
import { loadConfig, validateConfig } from "../../src/core/config.ts";
import { UsageError } from "../../src/core/errors.ts";
import { safeWrite, UnsafePathError } from "../../src/core/safefs.ts";
import { makeProject, TEST_CACHE_DIR } from "../helpers.ts";

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

test("the repository's .code-intel/cache is never read or written: a planted entry is ignored (verifier recheck F)", () => {
  const p = mk({ "a.js": "x\n" });
  const key = ResultCache.key("e", "id", [], p.dir, ["a.js"]);
  // A hostile repository commits a well-formed "no findings" entry at exactly the right key.
  mkdirSync(join(p.dir, ".code-intel/cache"), { recursive: true });
  writeFileSync(join(p.dir, ".code-intel/cache", `${key}.json`), '{"findings":[],"warnings":[]}');
  const cache = new ResultCache(p.dir, true);
  assert.equal(cache.get(key), null, "the in-repo entry must not be served");
  cache.put(key, { findings: [], warnings: ["real"] });
  assert.deepEqual(cache.get(key)?.warnings, ["real"], "entries live in the user cache directory");
  assert.equal(
    readFileSync(join(p.dir, ".code-intel/cache", `${key}.json`), "utf8"),
    '{"findings":[],"warnings":[]}',
    "the repository was not touched",
  );
  assert.ok(cache.dir.startsWith(TEST_CACHE_DIR), "tests are isolated from the real cache");
  assert.ok(!cache.dir.startsWith(p.dir), "never inside the repository");
});

test("the cache location follows CODE_INTEL_CACHE_DIR, and different repositories never share a directory", () => {
  const a = mk();
  const b = mk();
  assert.notEqual(defaultCacheDir(a.dir), defaultCacheDir(b.dir));
  assert.ok(defaultCacheDir(a.dir).startsWith(TEST_CACHE_DIR));
});

test("a cache write failure never fails anything", () => {
  const p = mk();
  const blocker = join(p.dir, "not-a-dir");
  writeFileSync(blocker, "file");
  new ResultCache(p.dir, true, join(blocker, "cache")).put("k", { findings: [], warnings: [] }); // parent is a file
});

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
  const r = await runInit(q.dir);
  assert.deepEqual(r.created, [".code-intel.json"]);
  assert.equal(existsSync(join(q.dir, ".code-intel")), false, "init creates nothing else");
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
  const cache = new ResultCache(p.dir, true);
  mkdirSync(cache.dir, { recursive: true });
  writeFileSync(join(cache.dir, `${key}.json`), '{"warnings":[]}');
  assert.equal(cache.get(key), null, "malformed entry is a miss, not a crash");
});

test("the cache key is bound to the repository, so a committed cache from elsewhere never matches", () => {
  const a = mk({ "a.js": "same\n" });
  const b = mk({ "a.js": "same\n" });
  assert.notEqual(
    ResultCache.key("e", "id", [], a.dir, ["a.js"]),
    ResultCache.key("e", "id", [], b.dir, ["a.js"]),
  );
});

test("protected baseline paths are normalized and case-folded (verifier recheck repro D)", () => {
  for (const evil of [
    ".//.git/config",
    ".GIT/config",
    ".Git/hooks/pre-commit",
    "a/../.git/config",
    ".git/./config",
    "x/.git/config",
    ".//.code-intel.json",
    "./.CODE-INTEL.JSON",
    ".\\.git\\config",
  ]) {
    const issues = validateConfig({ baseline: evil }).issues;
    assert.ok(
      issues.some((i) => i.path === "baseline"),
      `${evil} must be rejected`,
    );
  }
  for (const ok of [
    ".code-intel/baseline.json",
    "tools/gitignored-baseline.json",
    ".github/baseline.json",
  ]) {
    assert.deepEqual(validateConfig({ baseline: ok }).issues, [], `${ok} is fine`);
  }
});

test(
  "reading a baseline through a symlinked parent directory is refused and never echoes the outside file (verifier recheck repro D)",
  skipWin,
  () => {
    const outside = mk({ hosts: "127.0.0.1 localhost\nsecret-looking-text\n" });
    const p = mk();
    symlinkSync(outside.dir, join(p.dir, "out"));
    try {
      loadBaseline(p.dir, "out/hosts");
      assert.fail("must throw");
    } catch (e) {
      assert.ok(e instanceof UsageError);
      assert.equal(
        `${(e as Error).message}${(e as UsageError).details.join()}`.includes("secret-looking"),
        false,
      );
    }
    // an unparseable baseline reports a generic message, not the parser's quote of the file
    const q = mk({ ".code-intel/baseline.json": "{ secret-text-here }" });
    try {
      loadBaseline(q.dir, ".code-intel/baseline.json");
      assert.fail("must throw");
    } catch (e) {
      assert.equal(
        `${(e as Error).message}${(e as UsageError).details.join()}`.includes("secret-text"),
        false,
      );
    }
  },
);

test("the text report escapes bidirectional and zero-width characters too (verifier recheck G)", async () => {
  const { clean } = await import("../../src/report/text.ts");
  const evil = `x‮⁦y​z﻿.js`;
  const out = clean(evil);
  assert.equal(out, "x\\u202e\\u2066y\\u200bz\\ufeff.js");
  assert.equal(/[‪-‮⁦-⁩​﻿]/.test(out), false);
  assert.equal(
    clean("normal-file_name é ü.ts"),
    "normal-file_name é ü.ts",
    "ordinary Unicode is untouched",
  );
  assert.equal(clean("a\nb\tc\u001b"), "a\\nb\\tc\\x1b");
});
