import assert from "node:assert/strict";
import { after, test } from "node:test";
import { UsageError } from "../../src/core/errors.ts";
import { parseChangedLines, resolveTarget } from "../../src/core/targets.ts";
import { git, makeProject } from "../helpers.ts";

const projects: Array<{ cleanup(): void }> = [];
after(() => {
  for (const p of projects) p.cleanup();
});
const mk = (...a: Parameters<typeof makeProject>) => {
  const p = makeProject(...a);
  projects.push(p);
  return p;
};
const EXCL = ["node_modules"];

test("parseChangedLines handles hunks, single lines, deletions and spaces in names", () => {
  const diff = [
    "diff --git a/a.js b/a.js",
    "--- a/a.js",
    "+++ b/a.js",
    "@@ -1,0 +2,3 @@",
    "@@ -9 +12 @@",
    "@@ -20,2 +22,0 @@",
    "+++ b/with space.js\t",
    "@@ -1 +1,2 @@",
  ].join("\n");
  const m = parseChangedLines(diff);
  assert.deepEqual(m.get("a.js"), [
    { start: 2, end: 4 },
    { start: 12, end: 12 },
  ]);
  assert.deepEqual(m.get("with space.js"), [{ start: 1, end: 2 }]);
});

test("changed mode returns modified and untracked files, not unchanged ones", async () => {
  const p = mk({ "keep.js": "a\n", "mod.js": "a\nb\n" });
  p.commit();
  p.write("mod.js", "a\nb\nc\n");
  p.write("new.js", "x\n");
  const t = await resolveTarget({ cwd: p.dir, mode: null, ref: null, exclude: EXCL });
  assert.equal(t.mode, "changed");
  assert.deepEqual(t.files, ["mod.js", "new.js"]);
  assert.deepEqual(t.changedLines.get("mod.js"), [{ start: 3, end: 3 }]);
  assert.equal(t.changedLines.has("new.js"), false, "untracked = whole file");
});

test("staged mode sees only the index", async () => {
  const p = mk({ "a.js": "1\n", "b.js": "1\n" });
  p.commit();
  p.write("a.js", "2\n");
  p.write("b.js", "2\n");
  git(p.dir, "add", "a.js");
  const t = await resolveTarget({ cwd: p.dir, mode: "staged", ref: null, exclude: EXCL });
  assert.deepEqual(t.files, ["a.js"]);
});

test("since mode compares the working tree against a ref", async () => {
  const p = mk({ "a.js": "1\n" });
  p.commit("one");
  p.write("b.js", "1\n");
  p.commit("two");
  const t = await resolveTarget({ cwd: p.dir, mode: "since", ref: "HEAD~1", exclude: EXCL });
  assert.deepEqual(t.files, ["b.js"]);
});

test("since rejects invalid refs and option-looking refs", async () => {
  const p = mk({ "a.js": "1\n" });
  p.commit();
  await assert.rejects(
    resolveTarget({ cwd: p.dir, mode: "since", ref: "nope", exclude: EXCL }),
    UsageError,
  );
  await assert.rejects(
    resolveTarget({ cwd: p.dir, mode: "since", ref: "--output=x", exclude: EXCL }),
    UsageError,
  );
});

test("all mode lists tracked and untracked files but honors .gitignore and excludes", async () => {
  const p = mk({
    "src/a.js": "1\n",
    "node_modules/x.js": "1\n",
    ".gitignore": "ignored.js\n",
    "ignored.js": "1\n",
  });
  p.commit();
  p.write("src/new.js", "1\n");
  const t = await resolveTarget({ cwd: p.dir, mode: "all", ref: null, exclude: EXCL });
  assert.deepEqual(t.files, [".gitignore", "src/a.js", "src/new.js"]);
  assert.equal(t.excludedCount, 1);
});

test("deleted files and a repo without commits are handled", async () => {
  const p = mk({ "a.js": "1\n", "gone.js": "1\n" });
  const fresh = await resolveTarget({ cwd: p.dir, mode: null, ref: null, exclude: EXCL });
  assert.deepEqual(fresh.files, ["a.js", "gone.js"]);
  p.commit();
  const { rmSync } = await import("node:fs");
  rmSync(`${p.dir}/gone.js`);
  const t = await resolveTarget({ cwd: p.dir, mode: null, ref: null, exclude: EXCL });
  assert.deepEqual(t.files, []);
});

test("outside git: defaults to all, and git-only modes are usage errors", async () => {
  const p = mk({ "a.js": "1\n", "sub/b.js": "1\n" }, { git: false });
  const t = await resolveTarget({ cwd: p.dir, mode: null, ref: null, exclude: EXCL });
  assert.equal(t.mode, "all");
  assert.equal(t.isGit, false);
  assert.deepEqual(t.files, ["a.js", "sub/b.js"]);
  await assert.rejects(
    resolveTarget({ cwd: p.dir, mode: "staged", ref: null, exclude: EXCL }),
    UsageError,
  );
});
