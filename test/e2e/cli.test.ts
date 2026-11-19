import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { fakeAwsKey, git, makeProject } from "../helpers.ts";
import { OFFLINE, runCli } from "./helpers.ts";

const projects: Array<{ cleanup(): void }> = [];
after(() => {
  for (const p of projects) p.cleanup();
});
const project = (files: Record<string, string>, commit = true) => {
  const p = makeProject(files);
  if (commit) p.commit();
  projects.push(p);
  return p;
};

// A local semgrep rule keeps these tests deterministic and offline.
const RULE = `rules:
  - id: demo.no-eval
    languages: [javascript]
    severity: ERROR
    message: Do not call eval() on dynamic input.
    pattern: eval(...)
`;
const CONFIG = JSON.stringify({ engines: { semgrep: { configs: [".semgrep/rules.yml"] } } });
const SECRET = fakeAwsKey();

function defectProject() {
  const p = project({
    "README.md": "# demo\n",
    ".semgrep/rules.yml": RULE,
    ".code-intel.json": CONFIG,
    "src/ok.js": "export const ok = 1;\n",
  });
  p.write("src/bad.js", "export function run(x) {\n  return eval(x);\n}\n");
  p.write("config/creds.txt", `aws_access_key_id = ${SECRET}\n`);
  return p;
}

test("--version and --help exit 0; no args and unknown commands are usage errors", () => {
  const p = project({ "a.txt": "x\n" });
  assert.match(runCli(["--version"], p.dir).stdout, /^\d+\.\d+\.\d+/);
  const help = runCli(["--help"], p.dir);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: code-intel <command>/);
  assert.equal(runCli([], p.dir).code, 2);
  const bad = runCli(["frobnicate"], p.dir);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Unknown command 'frobnicate'/);
  assert.equal(runCli(["scan", "--help"], p.dir).code, 0);
});

test("invalid flags and conflicting scopes exit 2 with a useful message", () => {
  const p = project({ "a.txt": "x\n" });
  assert.equal(runCli(["scan", "--format", "yaml"], p.dir).code, 2);
  assert.equal(runCli(["scan", "--profile", "turbo"], p.dir).code, 2);
  assert.equal(runCli(["scan", "--fail-on", "urgent"], p.dir).code, 2);
  assert.equal(runCli(["scan", "--timeout", "5"], p.dir).code, 2);
  const both = runCli(["scan", "--staged", "--all"], p.dir);
  assert.equal(both.code, 2);
  assert.match(both.stderr, /only one of/);
  assert.equal(runCli(["scan", "--nonsense"], p.dir).code, 2);
});

test("invalid config exits 2 and names every problem with its path", () => {
  const p = project({
    ".code-intel.json": JSON.stringify({ failOn: "urgent", exclude: ["../x"], extra: 1 }),
  });
  const r = runCli(["scan", "--all"], p.dir);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /failOn: must be one of/);
  assert.match(r.stderr, /exclude\[0\]/);
  assert.match(r.stderr, /extra: unknown key/);
  const bad = project({ ".code-intel.json": "{ not json" });
  assert.equal(runCli(["scan", "--all"], bad.dir).code, 2);
});

test("init creates a valid config, never overwrites, and keeps the cache out of git", () => {
  const p = project({ "a.txt": "x\n" });
  const first = runCli(["init"], p.dir);
  assert.equal(first.code, 0);
  assert.equal(JSON.parse(readFileSync(join(p.dir, ".code-intel.json"), "utf8")).failOn, "high");
  assert.equal(readFileSync(join(p.dir, ".code-intel/.gitignore"), "utf8"), "cache/\n");
  const before = readFileSync(join(p.dir, ".code-intel.json"), "utf8");
  const second = runCli(["init"], p.dir);
  assert.equal(second.code, 2);
  assert.match(second.stderr, /already exists/);
  assert.equal(readFileSync(join(p.dir, ".code-intel.json"), "utf8"), before);
  assert.equal(runCli(["doctor"], p.dir).code === 0, true, "the generated config must validate");
});

test("scan: finds the injected secret and eval, exits 1, and never prints the secret", () => {
  const p = defectProject();
  for (const format of ["text", "json", "sarif"]) {
    const r = runCli(["scan", "--format", format, "--engines", "secrets,sast"], p.dir);
    assert.equal(r.code, 1, `${format}: expected exit 1\n${r.stderr}`);
    assert.equal(r.stdout.includes(SECRET), false, `${format} output leaked the secret`);
    assert.equal(r.stderr.includes(SECRET), false, `${format} stderr leaked the secret`);
    assert.match(r.stdout, /aws-access-token/);
    assert.match(r.stdout, /demo\.no-eval/);
  }
});

test("scan --format json has the documented shape", () => {
  const p = defectProject();
  const r = runCli(["scan", "--format", "json", "--engines", "secrets,sast"], p.dir);
  const j = JSON.parse(r.stdout);
  assert.equal(j.schemaVersion, 1);
  assert.equal(j.tool.name, "code-intelligence");
  assert.equal(j.profile, "quick");
  assert.equal(j.target.mode, "changed");
  assert.equal(j.complete, true);
  assert.equal(j.exitCode, 1);
  assert.equal(typeof j.durationMs, "number");
  const names = j.engines.map((e: { engine: string }) => e.engine).sort();
  assert.deepEqual(names, ["gitleaks", "semgrep"]);
  for (const e of j.engines) {
    assert.ok(["ok", "findings"].includes(e.status));
    assert.equal(typeof e.durationMs, "number");
  }
  const eval_ = j.findings.find((f: { ruleId: string }) => f.ruleId.endsWith("demo.no-eval"));
  assert.equal(eval_.file, "src/bad.js");
  assert.equal(eval_.line, 2);
  assert.equal(eval_.severity, "high");
  assert.match(eval_.fingerprint, /^[0-9a-f]{16}$/);
  assert.equal(
    JSON.stringify(j).includes(process.cwd()),
    false,
    "no absolute local paths in output",
  );
  assert.equal(JSON.stringify(j).includes(p.dir), false, "no absolute local paths in output");
});

test("scan --format sarif is structurally valid SARIF 2.1.0 with fingerprints and locations", () => {
  const p = defectProject();
  const s = JSON.parse(
    runCli(["scan", "--format", "sarif", "--engines", "secrets,sast"], p.dir).stdout,
  );
  assert.equal(s.version, "2.1.0");
  const run = s.runs[0];
  assert.equal(run.tool.driver.name, "code-intelligence");
  assert.ok(run.results.length >= 2);
  const ruleIds = new Set(run.tool.driver.rules.map((r: { id: string }) => r.id));
  for (const res of run.results) {
    assert.ok(ruleIds.has(res.ruleId), "every result references a declared rule");
    assert.ok(["error", "warning", "note"].includes(res.level));
    assert.ok(res.message.text.length > 0);
    assert.match(res.partialFingerprints["codeIntel/v1"], /^[0-9a-f]{16}$/);
    const loc = res.locations[0].physicalLocation;
    assert.ok(loc.artifactLocation.uri && !loc.artifactLocation.uri.startsWith("/"));
    assert.ok(loc.region.startLine >= 1);
  }
  assert.equal(run.invocations[0].executionSuccessful, true);
});

test("the result cache never stores the secret and is served on the second run", () => {
  const p = defectProject();
  runCli(["scan", "--format", "json", "--engines", "secrets"], p.dir);
  const second = JSON.parse(
    runCli(["scan", "--format", "json", "--engines", "secrets"], p.dir).stdout,
  );
  assert.equal(
    second.engines.find((e: { engine: string }) => e.engine === "gitleaks").cached,
    true,
  );
  const cacheDir = join(p.dir, ".code-intel/cache");
  assert.ok(existsSync(cacheDir));
  for (const f of readdirSync(cacheDir)) {
    assert.equal(
      readFileSync(join(cacheDir, f), "utf8").includes(SECRET),
      false,
      `cache file ${f} leaked the secret`,
    );
  }
  const fresh = JSON.parse(
    runCli(["scan", "--format", "json", "--no-cache", "--engines", "secrets"], p.dir).stdout,
  );
  assert.equal(fresh.engines[0].cached, false);
});

test("a clean change passes with exit 0", () => {
  const p = project({
    "a.js": "export const a = 1;\n",
    ".code-intel.json": CONFIG,
    ".semgrep/rules.yml": RULE,
  });
  p.write("b.js", "export const b = 2;\n");
  const r = runCli(["scan", "--engines", "secrets,sast"], p.dir);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Result: PASS/);
});

test("--fail-on critical turns a high finding into a pass but still reports it", () => {
  const p = defectProject();
  const r = runCli(["scan", "--fail-on", "critical", "--engines", "secrets,sast"], p.dir);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /demo\.no-eval/);
});

test("changed-line filter hides SAST findings on untouched lines and says so", () => {
  const p = project({
    "src/old.js": "export function a(x) {\n  return eval(x);\n}\n",
    ".code-intel.json": CONFIG,
    ".semgrep/rules.yml": RULE,
  });
  p.write(
    "src/old.js",
    `${readFileSync(join(p.dir, "src/old.js"), "utf8")}export const added = 1;\n`,
  );
  const hidden = runCli(["scan", "--engines", "sast"], p.dir);
  assert.equal(hidden.code, 0);
  assert.match(hidden.stdout, /1 SAST finding\(s\) on unchanged lines were hidden/);
  const all = runCli(["scan", "--all", "--engines", "sast"], p.dir);
  assert.equal(all.code, 1);
});

test("baseline + --new-only: known findings disappear, new ones still fail", () => {
  const p = defectProject();
  const b = runCli(["baseline", "--engines", "secrets,sast"], p.dir);
  assert.equal(b.code, 0, b.stdout + b.stderr);
  assert.match(b.stdout, /Baseline written: 2 finding\(s\)/);
  const known = runCli(["scan", "--all", "--new-only", "--engines", "secrets,sast"], p.dir);
  assert.equal(known.code, 0, known.stdout);
  assert.match(known.stdout, /2 finding\(s\) matched the baseline/);
  p.write("src/worse.js", "export const f = (y) => eval(y);\n");
  const fresh = runCli(["scan", "--all", "--new-only", "--engines", "secrets,sast"], p.dir);
  assert.equal(fresh.code, 1);
  assert.match(fresh.stdout, /src\/worse\.js/);
});

test("--staged scans only the index", () => {
  const p = project({
    "a.js": "export const a = 1;\n",
    ".code-intel.json": CONFIG,
    ".semgrep/rules.yml": RULE,
  });
  p.write("bad.js", "eval(process.argv[2]);\n");
  const none = runCli(["scan", "--staged", "--engines", "sast"], p.dir);
  assert.equal(none.code, 0);
  git(p.dir, "add", "bad.js");
  assert.equal(runCli(["scan", "--staged", "--engines", "sast"], p.dir).code, 1);
});

test("--since compares against a ref", () => {
  const p = project({
    "a.js": "export const a = 1;\n",
    ".code-intel.json": CONFIG,
    ".semgrep/rules.yml": RULE,
  });
  p.write("bad.js", "eval(process.argv[2]);\n");
  p.commit("add bad");
  assert.equal(runCli(["scan", "--engines", "sast"], p.dir).code, 0, "nothing uncommitted");
  assert.equal(runCli(["scan", "--since", "HEAD~1", "--engines", "sast"], p.dir).code, 1);
});

test("registry rulesets and dependency audit (network)", { skip: OFFLINE }, () => {
  const p = project({
    "package.json": '{"name":"x","version":"1.0.0","dependencies":{"lodash":"4.17.15"}}\n',
    "package-lock.json": JSON.stringify({
      name: "x",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "x", version: "1.0.0", dependencies: { lodash: "4.17.15" } },
        "node_modules/lodash": {
          version: "4.17.15",
          resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz",
        },
      },
    }),
  });
  p.write("package-lock.json", `${readFileSync(join(p.dir, "package-lock.json"), "utf8")}\n`);
  const r = runCli(["scan", "--format", "json", "--engines", "deps"], p.dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  const f = j.findings.find((x: { ruleId: string }) => x.ruleId === "GHSA-35jh-r3h4-6jhm");
  assert.ok(f, "lodash command-injection advisory is reported");
  assert.equal(f.category, "deps");
  assert.equal(f.file, "package-lock.json");
  assert.match(f.remediation, /Upgrade lodash to 4\.17\.21/);
  assert.equal(f.line, null);
});

test("trivy can be pinned for deps and reports fix guidance (network)", { skip: OFFLINE }, () => {
  const lock = JSON.stringify({
    name: "x",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "x", version: "1.0.0", dependencies: { lodash: "4.17.15" } },
      "node_modules/lodash": {
        version: "4.17.15",
        resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz",
      },
    },
  });
  const p = project({
    "package.json": '{"name":"x","version":"1.0.0"}\n',
    "package-lock.json": lock,
  });
  p.write("package-lock.json", `${lock}\n`);
  const r = runCli(["scan", "--format", "json", "--engines", "trivy"], p.dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(
    j.engines.map((e: { engine: string }) => e.engine),
    ["trivy"],
  );
  const f = j.findings.find((x: { ruleId: string }) => x.ruleId === "CVE-2020-8203");
  assert.ok(f);
  assert.match(f.remediation, /Upgrade lodash to 4\.17\.19/);
  assert.equal(f.severity, "high");
});

const SGCONFIG = "ruleDirs:\n  - rules\n";
const SGRULE = `id: domain-must-not-import-infra
language: TypeScript
severity: error
message: The domain layer must not depend on infrastructure.
note: Depend on a port owned by the domain and implement it in infra.
files:
  - src/domain/**
rule:
  any:
    - pattern: import $A from "$PATH"
    - pattern: import { $$$A } from "$PATH"
constraints:
  PATH:
    regex: "infra"
`;

test("architecture: project ast-grep rules enforce layer boundaries; no sgconfig means an explicit skip", () => {
  const p = project({
    "sgconfig.yml": SGCONFIG,
    "rules/domain.yml": SGRULE,
    "src/infra/db.ts": "export class Db {}\n",
    "src/domain/ok.ts": "export const ok = 1;\n",
  });
  p.write("src/domain/user.ts", 'import { Db } from "../infra/db";\nexport const db = new Db();\n');
  const r = runCli(["scan", "--format", "json", "--engines", "architecture"], p.dir);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.engines[0].engine, "ast-grep");
  const f = j.findings[0];
  assert.equal(f.ruleId, "domain-must-not-import-infra");
  assert.equal(f.file, "src/domain/user.ts");
  assert.equal(f.line, 1);
  assert.equal(f.severity, "high");
  assert.match(f.remediation, /port/);

  const clean = project({
    "sgconfig.yml": SGCONFIG,
    "rules/domain.yml": SGRULE,
    "src/domain/ok.ts": "export const ok = 1;\n",
  });
  clean.write("src/domain/more.ts", "export const more = 2;\n");
  assert.equal(runCli(["scan", "--engines", "architecture"], clean.dir).code, 0);

  const none = project({ "a.ts": "export const a = 1;\n" });
  none.write("b.ts", "export const b = 1;\n");
  const skipped = JSON.parse(
    runCli(["scan", "--format", "json", "--engines", "architecture"], none.dir).stdout,
  );
  assert.equal(skipped.engines[0].status, "skipped");
  assert.match(skipped.engines[0].reason, /no sgconfig\.yml/);
});

test("architecture: an invalid rule is an error (exit 3), never a pass", () => {
  const p = project({
    "sgconfig.yml": SGCONFIG,
    "rules/bad.yml": "id: x\nlanguage: Nope\nrule: {pattern: a}\n",
    "a.ts": "export const a = 1;\n",
  });
  p.write("b.ts", "export const b = 1;\n");
  const j = JSON.parse(
    runCli(["scan", "--format", "json", "--engines", "architecture"], p.dir).stdout,
  );
  assert.equal(j.engines[0].status, "error");
  assert.equal(j.exitCode, 3);
});
