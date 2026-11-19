import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { mergeDuplicateSecrets, toFindings } from "../../src/core/normalize.ts";
import { toRel } from "../../src/engines/util.ts";
import type { Finding, RawFinding } from "../../src/types.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("toRel resolves engine paths through a symlinked root (macOS /var vs /private/var)", {
  skip: process.platform === "win32",
}, () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ci-sym-")));
  dirs.push(base);
  const real = join(base, "real");
  mkdirSync(join(real, "sub"), { recursive: true });
  writeFileSync(join(real, "sub", "package-lock.json"), "{}");
  const link = join(base, "link");
  symlinkSync(real, link);
  // Git reports the logical root (link); the engine reports the resolved one (real).
  assert.equal(toRel(link, join(real, "sub", "package-lock.json")), "sub/package-lock.json");
  assert.equal(toRel(link, join(link, "sub", "package-lock.json")), "sub/package-lock.json");
  // The reverse direction, which is what actually happened on macOS: git gives the real root
  // (/private/var/...), the engine reports the logical path (/var/...).
  assert.equal(toRel(real, join(link, "sub", "package-lock.json")), "sub/package-lock.json");
  assert.equal(toRel(real, "already/relative.js"), "already/relative.js");
  assert.equal(toRel(real, "./dot/slash.js"), "dot/slash.js");
});

const raw = (over: Partial<RawFinding> = {}): RawFinding => ({
  engine: "e",
  ruleId: "r",
  category: "sast",
  severity: "high",
  file: "a.js",
  line: 1,
  endLine: 1,
  message: "m",
  remediation: null,
  references: [],
  ...over,
});

test("a path outside the repository never reaches a finding verbatim (no local path leaks)", () => {
  const out = toFindings(
    [
      raw({
        file: "../../../../var/folders/xy/tmp.abc/package-lock.json",
        line: null,
        endLine: null,
        key: "k1",
      }),
      raw({ file: "/Users/someone/secret/project/x.js", line: null, endLine: null, key: "k2" }),
    ],
    process.cwd(),
  );
  assert.deepEqual(
    out.map((f) => f.file),
    ["<outside-repository>/package-lock.json", "<outside-repository>/x.js"],
  );
  assert.equal(JSON.stringify(out).includes("someone"), false);
  assert.equal(JSON.stringify(out).includes("folders"), false);
});

const F = (over: Partial<Finding>): Finding => ({
  fingerprint: "0".repeat(16),
  engine: "semgrep",
  ruleId: "semgrep.secrets.aws",
  category: "secrets",
  severity: "high",
  file: "creds.txt",
  line: 1,
  endLine: 1,
  message: "m",
  remediation: null,
  references: [],
  alsoReportedBy: [],
  ...over,
});

test("the same secret reported by two engines becomes one finding that credits the other", () => {
  const out = mergeDuplicateSecrets([
    F({}),
    F({ engine: "gitleaks", ruleId: "aws-access-token", fingerprint: "1".repeat(16) }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.engine, "gitleaks", "the dedicated scanner wins");
  assert.deepEqual(out[0]?.alsoReportedBy, ["semgrep"]);
});

test("merging keeps the highest severity and leaves everything else untouched", () => {
  const out = mergeDuplicateSecrets([
    F({ engine: "gitleaks", severity: "medium", ruleId: "g" }),
    F({ severity: "critical" }),
    F({ line: 2, ruleId: "other-line" }),
    F({ line: null, endLine: null, ruleId: "no-line" }),
    F({ category: "sast", ruleId: "sast-same-line" }),
    F({ file: "other.txt", ruleId: "other-file" }),
  ]);
  const merged = out.find((f) => f.ruleId === "g");
  assert.equal(merged?.severity, "critical");
  assert.equal(out.length, 5);
  assert.deepEqual(out.map((f) => f.ruleId).sort(), [
    "g",
    "no-line",
    "other-file",
    "other-line",
    "sast-same-line",
  ]);
});
