import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { OFFLINE, runCli } from "../e2e/helpers.ts";
import { cleanEnv, makeProject, type Project } from "../helpers.ts";

const MATH = `export function clamp(x, lo, hi) {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
`;
const ADULT = "export const isAdult = (age) => age >= 18;\n";
const WEAK_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { clamp } from "../src/math.js";
import { isAdult } from "../src/adult.js";
test("clamp", () => { assert.equal(clamp(5, 0, 10), 5); assert.equal(clamp(-1, 0, 10), 0); });
test("adult", () => { assert.equal(isAdult(30), true); });
`;
const STRONG_TEST = `import assert from "node:assert/strict";
import { test } from "node:test";
import { isAdult } from "../src/adult.js";
test("adult boundary", () => {
  assert.equal(isAdult(30), true);
  assert.equal(isAdult(18), true);
  assert.equal(isAdult(17), false);
  assert.equal(isAdult(0), false);
});
`;

let p: Project;
const mutate = (...args: string[]) => runCli(["mutate", "--json", ...args], p.dir);

before(
  () => {
    p = makeProject({
      ".gitignore": "node_modules\n",
      "package.json": JSON.stringify({
        name: "m",
        version: "1.0.0",
        type: "module",
        scripts: { test: "node --test" },
      }),
      "src/math.js": MATH,
      "src/adult.js": "export const isAdult = (age) => age > 0;\n",
      "test/math.test.js": WEAK_TEST,
    });
    execFileSync(
      "npm",
      ["install", "--no-audit", "--no-fund", "--save-dev", "@stryker-mutator/core@10.1.1"],
      { cwd: p.dir, env: cleanEnv(), stdio: "ignore" },
    );
    p.commit("base");
  },
  { timeout: 300_000 },
);
after(() => p?.cleanup());

test("weak tests: survivors are reported on the changed lines only, and the project is left clean", {
  skip: OFFLINE,
  timeout: 300_000,
}, () => {
  p.write("src/adult.js", ADULT);
  const r = mutate();
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.status, "ok");
  assert.equal(j.engine, "stryker");
  assert.deepEqual(
    j.files.map((f: { file: string }) => f.file),
    ["src/adult.js"],
    "math.js was not changed, so it is not mutated",
  );
  const f = j.files[0];
  assert.ok(f.total > 0);
  assert.ok(f.survived >= 1, "age >= 18 has no boundary test, so a mutant must survive");
  assert.ok(f.survivors.every((s: { line: number }) => s.line === 1));
  assert.ok(f.score < 100);
  assert.match(j.notes.join(" "), /limited to the changed lines/);
  assert.equal(existsSync(join(p.dir, "reports")), false, "reports/ must not be left behind");
  assert.equal(
    existsSync(join(p.dir, ".stryker-tmp")),
    false,
    ".stryker-tmp must not be left behind",
  );
});

test("--min-score fails a weak suite; a strong suite scores 100 and passes", {
  skip: OFFLINE,
  timeout: 300_000,
}, () => {
  p.write("src/adult.js", ADULT);
  assert.equal(mutate("--min-score", "99").code, 1);
  p.write("test/math.test.js", STRONG_TEST);
  const r = mutate("--min-score", "99");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.totals.score, 100);
  assert.equal(j.totals.survived, 0);
});

test("a failing baseline test suite is an error (exit 3), never a pass", {
  skip: OFFLINE,
  timeout: 300_000,
}, () => {
  p.write("src/adult.js", ADULT);
  p.write(
    "test/math.test.js",
    `import { test } from "node:test";\ntest("broken", () => { throw new Error("red"); });\n`,
  );
  const r = mutate();
  assert.equal(r.code, 3);
  assert.equal(JSON.parse(r.stdout).status, "error");
});

test("unsupported languages are listed as skipped, not silently ignored", () => {
  const q = makeProject({ "a.py": "x = 1\n" });
  try {
    q.commit();
    q.write("a.py", "x = 2\n");
    const j = JSON.parse(runCli(["mutate", "--json"], q.dir).stdout);
    assert.equal(j.status, "skipped");
    assert.equal(j.exitCode, 0);
    assert.match(j.skippedFiles[0].reason, /no mutation engine for this language/);
  } finally {
    q.cleanup();
  }
});

test("without StrykerJS in the project: unavailable with the install command, exit 3", () => {
  const q = makeProject({
    "package.json": '{"name":"q","scripts":{"test":"node --test"}}',
    "a.js": "export const a = 1;\n",
  });
  try {
    q.commit();
    q.write("a.js", "export const a = 2;\n");
    const r = runCli(["mutate", "--json"], q.dir);
    assert.equal(r.code, 3);
    const j = JSON.parse(r.stdout);
    assert.equal(j.status, "unavailable");
    assert.match(j.reason, /npm install --save-dev @stryker-mutator\/core/);
  } finally {
    q.cleanup();
  }
});

test("bad usage: --all and mixing files with scope flags exit 2", () => {
  assert.equal(runCli(["mutate", "--all"], process.cwd()).code, 2);
  assert.equal(runCli(["mutate", "src/a.js", "--staged"], process.cwd()).code, 2);
  assert.equal(runCli(["mutate", "../../etc/passwd"], process.cwd()).code, 2);
  assert.equal(runCli(["scan", "stray-arg"], process.cwd()).code, 2);
});

test("mutate rejects symlinks and option-looking file arguments (verifier notes)", {
  skip: process.platform === "win32",
}, () => {
  const outside = makeProject({ "secret.js": "export const s = 1;\n" }, { git: false });
  const q = makeProject({ "a.js": "export const a = 1;\n" });
  try {
    q.commit();
    symlinkSync(join(outside.dir, "secret.js"), join(q.dir, "link.js"));
    assert.equal(
      runCli(["mutate", "link.js"], q.dir).code,
      2,
      "a symlink to a file outside the repository is refused",
    );
    assert.equal(runCli(["mutate", "nope.js"], q.dir).code, 2);
  } finally {
    q.cleanup();
    outside.cleanup();
  }
});
