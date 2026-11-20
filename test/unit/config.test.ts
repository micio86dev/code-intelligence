import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_EXCLUDE, defaultConfig, validateConfig } from "../../src/core/config.ts";

test("empty object yields defaults with no issues", () => {
  const { config, issues } = validateConfig({});
  assert.deepEqual(issues, []);
  assert.deepEqual(config, defaultConfig());
});

test("user exclude patterns extend the defaults", () => {
  const { config, issues } = validateConfig({ exclude: ["generated/**"] });
  assert.deepEqual(issues, []);
  assert.deepEqual(config.exclude, [...DEFAULT_EXCLUDE, "generated/**"]);
});

test("unknown keys and wrong types report precise paths", () => {
  const { issues } = validateConfig({
    failOn: "urgent",
    nope: 1,
    profiles: { quick: { timeoutMs: 5, extra: true }, slow: {} },
    engines: { semgrep: { configs: ["https://evil.example/rules"] }, trivy: {} },
  });
  const paths = issues.map((i) => i.path).sort();
  assert.deepEqual(paths, [
    "engines.semgrep.configs[0]",
    "engines.trivy",
    "failOn",
    "nope",
    "profiles.quick.extra",
    "profiles.quick.timeoutMs",
    "profiles.slow",
  ]);
});

test("path traversal and absolute paths are rejected", () => {
  const { issues } = validateConfig({
    exclude: ["../outside"],
    baseline: "/etc/passwd",
    engines: { gitleaks: { configPath: "../../x.toml" } },
  });
  assert.deepEqual(issues.map((i) => i.path).sort(), [
    "baseline",
    "engines.gitleaks.configPath",
    "exclude[0]",
  ]);
});

test("semgrep configs accept registry ids and repo-relative rule dirs, never flags", () => {
  const ok = validateConfig({
    engines: { semgrep: { configs: ["p/default", "r/python.lang", ".semgrep/rules"] } },
  });
  assert.deepEqual(ok.issues, []);
  const bad = validateConfig({ engines: { semgrep: { configs: ["--config=evil"] } } });
  assert.equal(bad.issues.length > 0, true);
});

test("non-object config is rejected", () => {
  assert.equal(validateConfig([]).issues[0]?.path, "$");
  assert.equal(validateConfig("x").issues[0]?.path, "$");
});

test("protected paths: Windows aliases of .git and of the config file are protected too", async () => {
  const { isProtectedPath } = await import("../../src/core/config.ts");
  // Always protected (the original behavior)
  for (const p of [
    ".git/config",
    ".GIT/hooks/x",
    "a/../.git/config",
    ".//.git/config",
    ".code-intel.json",
    ".CODE-INTEL.JSON",
  ]) {
    assert.equal(isProtectedPath(p), true, p);
  }
  // Windows resolves these to the same directory or file: trailing dots and spaces are dropped, a stream
  // suffix selects an alternate view of the same entry, and 8.3 short names alias the long name.
  for (const p of [
    ".git./config",
    ".git /config",
    ".git::$INDEX_ALLOCATION/config",
    ".git::$DATA",
    "GIT~1/config",
    "git~2/hooks/pre-commit",
    "sub/.GIT.../x",
    ".code-intel.json.",
    ".code-intel.json::$DATA",
    "CODE-I~1.JSO",
  ]) {
    assert.equal(isProtectedPath(p), true, p);
  }
  // Unchanged: ordinary paths, including ones that merely contain similar words.
  for (const p of [
    ".code-intel/baseline.json",
    "git/readme.md",
    "src/gitlike.ts",
    "docs/.github/x.yml",
    "my~notes.txt",
    ".gitignore",
    ".github/workflows/ci.yml",
  ]) {
    assert.equal(isProtectedPath(p), false, p);
  }
});

test("Windows aliases of .git resolve to the real directory on a real volume, and are protected", {
  skip: process.platform !== "win32",
}, async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { isProtectedPath } = await import("../../src/core/config.ts");
  const dir = mkdtempSync(join(tmpdir(), "ci-winalias-"));
  try {
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), "x");
    // The premise of the protection: the OS really treats these spellings as the same directory.
    assert.equal(existsSync(join(dir, ".git.", "config")), true, "trailing dot resolves to .git");
    assert.equal(existsSync(join(dir, ".GIT", "config")), true, "case-insensitive");
    assert.equal(isProtectedPath(".git./config"), true);
    assert.equal(isProtectedPath(".GIT/config"), true);
    // 8.3 short name, if this volume generates them (it can be disabled per volume).
    const listing = execFileSync("cmd.exe", ["/d", "/c", "dir", "/x", "/a:d", dir], {
      encoding: "utf8",
    });
    const short = /^\S+\s+\S+\s+<DIR>\s+(\S+~\d+)\s+\.git\s*$/im.exec(listing)?.[1];
    if (short) {
      assert.equal(
        existsSync(join(dir, short, "config")),
        true,
        `short name ${short} resolves to .git`,
      );
      assert.equal(isProtectedPath(`${short}/config`), true, `short name ${short} is protected`);
    } else {
      console.log("8.3 short names are not generated on this volume; that part was not exercised");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
