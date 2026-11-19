import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { cleanEnv, makeProject } from "../helpers.ts";
import { runCli } from "./helpers.ts";

const projects: Array<{ cleanup(): void }> = [];
after(() => {
  for (const p of projects) p.cleanup();
});

const FILES = {
  "src/math.js": "export const add = (a, b) => a + b;\n",
  "src/util.js": 'import { add } from "./math.js";\nexport const inc = (x) => add(x, 1);\n',
  "src/other.js": "export const other = () => 1;\n",
  "test/util.test.js": 'import { inc } from "../src/util.js";\ninc(1);\n',
  "test/other.test.js": 'import { other } from "../src/other.js";\nother();\n',
};

function project() {
  const p = makeProject(FILES);
  p.commit();
  projects.push(p);
  return p;
}

const impact = (cwd: string, ...args: string[]) =>
  JSON.parse(runCli(["impact", "--json", ...args], cwd).stdout);

test("heuristic: finds direct importers, labels the method, and admits it cannot see transitive ones", () => {
  const p = project();
  p.write("src/util.js", `${FILES["src/util.js"]}export const dec = (x) => x - 1;\n`);
  const direct = impact(p.dir);
  assert.equal(direct.method, "heuristic");
  assert.deepEqual(direct.affectedTests, ["test/util.test.js"]);
  assert.match(direct.notes.join(" "), /Transitive dependents are NOT detected/);

  // math.js is only reached through util.js: the heuristic must not pretend otherwise.
  const p2 = project();
  p2.write("src/math.js", `${FILES["src/math.js"]}export const sub = (a, b) => a - b;\n`);
  const transitive = impact(p2.dir);
  assert.equal(transitive.method, "heuristic");
  assert.deepEqual(transitive.affectedTests, []);
});

test("a changed test file is always listed", () => {
  const p = project();
  p.write("test/other.test.js", `${FILES["test/other.test.js"]}other();\n`);
  assert.deepEqual(impact(p.dir).affectedTests, ["test/other.test.js"]);
});

test("--since works and impact rejects --all", () => {
  const p = project();
  p.write("src/other.js", `${FILES["src/other.js"]}export const x = 2;\n`);
  p.commit("change other");
  assert.deepEqual(impact(p.dir, "--since", "HEAD~1").affectedTests, ["test/other.test.js"]);
  assert.equal(runCli(["impact", "--all"], p.dir).code, 2);
});

const hasCodegraph = spawnSync("codegraph", ["--version"], { encoding: "utf8" }).status === 0;

test("codegraph: follows the import graph transitively", { skip: !hasCodegraph }, () => {
  const p = project();
  const init = spawnSync("codegraph", ["init", p.dir], {
    cwd: p.dir,
    env: cleanEnv(),
    encoding: "utf8",
  });
  assert.equal(init.status, 0, init.stderr);
  p.write("src/math.js", `${FILES["src/math.js"]}export const sub = (a, b) => a - b;\n`);
  const r = impact(p.dir);
  assert.equal(r.method, "codegraph");
  assert.deepEqual(r.affectedTests, ["test/util.test.js"]);
});
