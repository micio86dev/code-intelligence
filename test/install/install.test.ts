import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { cleanEnv, makeProject } from "../helpers.ts";

const REPO = new URL("../../", import.meta.url).pathname;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let work: string;
let prefix: string;
let bin: string;

const env = () => cleanEnv({ npm_config_update_notifier: "false" });

before(
  () => {
    work = realpathSync(mkdtempSync(join(tmpdir(), "ci-install-")));
    prefix = join(work, "prefix");
    // `npm pack` runs the prepack build, exactly what a release does.
    const out = execFileSync(npm, ["pack", "--silent", "--pack-destination", work], {
      cwd: REPO,
      env: env(),
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    const tgz = join(work, out.trim().split("\n").pop() as string);
    execFileSync(npm, ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tgz], {
      env: env(),
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    bin = join(prefix, process.platform === "win32" ? "code-intel.cmd" : "bin/code-intel");
  },
  { timeout: 300_000 },
);
after(() => rmSync(work, { recursive: true, force: true }));

const run = (args: string[], cwd = work) =>
  spawnSync(bin, args, { cwd, env: env(), encoding: "utf8", shell: process.platform === "win32" });

test("installed from a tarball into a clean prefix: version, help and doctor work", () => {
  assert.ok(existsSync(bin), "bin was linked");
  const v = run(["--version"]);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /^\d+\.\d+\.\d+/);
  assert.match(run(["--help"]).stdout, /Usage: code-intel <command>/);
  const d = run(["doctor", "--json"]);
  const j = JSON.parse(d.stdout);
  assert.equal(j.tool.name, "code-intelligence");
  assert.ok(Array.isArray(j.engines) && j.engines.length >= 4);
});

test("the packed tarball ships compiled code and schemas, never sources or tests", () => {
  const pkgDir = join(prefix, "lib/node_modules/code-intelligence");
  const dir = existsSync(pkgDir) ? pkgDir : join(prefix, "node_modules/code-intelligence");
  const top = readdirSync(dir);
  assert.ok(top.includes("dist"));
  assert.ok(top.includes("LICENSE"));
  for (const forbidden of ["src", "test", "bench", ".github", "tsconfig.json"]) {
    assert.equal(top.includes(forbidden), false, `${forbidden} must not be published`);
  }
});

test("the installed CLI scans a project end to end", () => {
  const p = makeProject({ "a.js": "export const a = 1;\n" });
  try {
    p.commit();
    p.write("b.js", "export const b = 2;\n");
    const r = run(["scan", "--format", "json", "--engines", "secrets"], p.dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.complete, true);
    assert.equal(j.engines[0].engine, "gitleaks");
  } finally {
    p.cleanup();
  }
});

test("uninstall removes the binary and leaves nothing behind", () => {
  execFileSync(npm, ["uninstall", "--global", "--prefix", prefix, "code-intelligence"], {
    env: env(),
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  assert.equal(existsSync(bin), false);
  const leftovers = existsSync(join(prefix, "lib/node_modules"))
    ? readdirSync(join(prefix, "lib/node_modules"))
    : [];
  assert.deepEqual(leftovers, []);
});
