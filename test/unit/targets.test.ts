import assert from "node:assert/strict";
import { after, test } from "node:test";
import { UsageError } from "../../src/core/errors.ts";
import { parseChangedLines, resolveTarget } from "../../src/core/targets.ts";
import { GIT_ENV, git, makeProject } from "../helpers.ts";

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
    "index 111..222 100644",
    "--- a/a.js",
    "+++ b/a.js",
    "@@ -1,0 +2,3 @@",
    "+x",
    "+y",
    "+z",
    "@@ -9 +12 @@",
    "-old",
    "+new",
    "@@ -20,2 +22,0 @@",
    "-gone1",
    "-gone2",
    "\\ No newline at end of file",
    "diff --git a/with space.js b/with space.js",
    "--- a/with space.js\t",
    "+++ b/with space.js\t",
    "@@ -1 +1,2 @@",
    "-q",
    "+r",
    "+s",
    "",
  ].join("\n");
  const m = parseChangedLines(diff);
  assert.deepEqual(m.get("a.js"), [
    { start: 2, end: 4 },
    { start: 12, end: 12 },
  ]);
  assert.deepEqual(m.get("with space.js"), [{ start: 1, end: 2 }]);
});

test("parseChangedLines cannot be fooled by added lines that look like file headers (verifier repro)", () => {
  // The added source line `++ /dev/null` renders in the diff as `+++ /dev/null`; a naive parser
  // takes it for a header and drops every later hunk of the file, hiding findings from the line filter.
  const diff = [
    "diff --git a/app.js b/app.js",
    "--- a/app.js",
    "+++ b/app.js",
    "@@ -1,0 +1,4 @@",
    "+a",
    "+/*",
    "+++ /dev/null",
    "+*/",
    "@@ -9,0 +12,2 @@",
    "+eval(userInput)",
    "++ b/other.js",
    "",
  ].join("\n");
  const m = parseChangedLines(diff);
  assert.deepEqual(m.get("app.js"), [
    { start: 1, end: 4 },
    { start: 12, end: 13 },
  ]);
  assert.equal(
    m.has("other.js"),
    false,
    "a spoofed header must not create or redirect a file entry",
  );
  assert.equal(m.size, 1);
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

test("a file reached through a symlinked parent directory is never scanned (verifier repro)", {
  skip: process.platform === "win32",
}, async () => {
  const { mkdirSync, rmSync, symlinkSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const outside = mk({ "secret.js": "outside\n" }, { git: false });
  const p = mk({ "d/f.js": "inside\n", "ok.js": "ok\n" });
  p.commit();
  // The index says d/f.js, but the worktree now has d as a link to a directory outside the repository.
  rmSync(join(p.dir, "d"), { recursive: true });
  symlinkSync(outside.dir, join(p.dir, "d"));
  writeFileSync(join(outside.dir, "f.js"), "outside token\n");
  mkdirSync(join(p.dir, "real"), { recursive: true });
  writeFileSync(join(p.dir, "real", "x.js"), "x\n");
  const t = await resolveTarget({ cwd: p.dir, mode: "all", ref: null, exclude: EXCL });
  assert.equal(t.files.includes("d/f.js"), false, "must not read through the symlinked directory");
  assert.ok(t.files.includes("ok.js") && t.files.includes("real/x.js"));
});

test("a hostile .git/config textconv is not executed by diff (verifier repro)", {
  skip: process.platform === "win32",
}, async () => {
  const { chmodSync, existsSync, rmSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const p = mk({ "a.txt": "one\n", ".gitattributes": "* diff=pwn\n" });
  p.commit();
  const helper = mk({}, { git: false });
  const marker = join(helper.dir, "PWNED");
  const script = join(helper.dir, "conv.sh");
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat "$1"\n`);
  chmodSync(script, 0o755);
  git(p.dir, "config", "diff.pwn.textconv", script);
  writeFileSync(join(p.dir, "a.txt"), "one\ntwo\n");

  // Precondition: the vector is real here. A plain `git diff` runs the configured textconv.
  execFileSync("git", ["diff", "HEAD"], { cwd: p.dir, env: GIT_ENV, stdio: "ignore" });
  assert.equal(existsSync(marker), true, "precondition: plain git diff executes textconv");
  rmSync(marker);

  const t = await resolveTarget({ cwd: p.dir, mode: "changed", ref: null, exclude: EXCL });
  assert.deepEqual(t.files, ["a.txt"]);
  assert.deepEqual(t.changedLines.get("a.txt"), [{ start: 2, end: 2 }]);
  assert.equal(
    existsSync(marker),
    false,
    "code-intel must not run the repository's textconv command",
  );
});

test("a hostile .git/config clean filter is not executed by diff (verifier recheck repro C)", {
  skip: process.platform === "win32",
}, async () => {
  const { chmodSync, existsSync, rmSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const p = mk({ "a.txt": "one\n", ".gitattributes": "* filter=pwn\n" });
  p.commit();
  const helper = mk({}, { git: false });
  const marker = join(helper.dir, "PWNED");
  const script = join(helper.dir, "clean.sh");
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
  chmodSync(script, 0o755);
  git(p.dir, "config", "filter.pwn.clean", script);
  git(p.dir, "config", "filter.pwn.smudge", "cat");
  writeFileSync(join(p.dir, "a.txt"), "one\ntwo\n");

  execFileSync("git", ["diff", "HEAD"], { cwd: p.dir, env: GIT_ENV, stdio: "ignore" });
  assert.equal(existsSync(marker), true, "precondition: a plain git diff runs the clean filter");
  rmSync(marker);

  const t = await resolveTarget({ cwd: p.dir, mode: "changed", ref: null, exclude: EXCL });
  assert.deepEqual(t.files, ["a.txt"]);
  assert.deepEqual(t.changedLines.get("a.txt"), [{ start: 2, end: 2 }], "the diff still computes");
  assert.equal(existsSync(marker), false, "code-intel must not run the repository's clean filter");
});

test("a filter whose NAME contains '=' is neutralized too (verifier spot-check C1)", {
  skip: process.platform === "win32",
}, async () => {
  const { chmodSync, existsSync, rmSync, writeFileSync, appendFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const p = mk({ "a.txt": "one\n", ".gitattributes": "* filter=a=b\n" });
  p.commit();
  const helper = mk({}, { git: false });
  const marker = join(helper.dir, "PWNED");
  const script = join(helper.dir, "clean.sh");
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
  chmodSync(script, 0o755);
  // `git config` refuses odd names, so write the section by hand, as a hostile .git/config would.
  appendFileSync(join(p.dir, ".git", "config"), `[filter "a=b"]\n\tclean = ${script}\n`);
  writeFileSync(join(p.dir, "a.txt"), "one\ntwo\n");

  execFileSync("git", ["diff", "HEAD"], { cwd: p.dir, env: GIT_ENV, stdio: "ignore" });
  assert.equal(existsSync(marker), true, "precondition: plain git diff runs the filter named a=b");
  rmSync(marker);

  const t = await resolveTarget({ cwd: p.dir, mode: "changed", ref: null, exclude: EXCL });
  assert.deepEqual(t.changedLines.get("a.txt"), [{ start: 2, end: 2 }]);
  assert.equal(existsSync(marker), false, "the '='-named filter must not run");
});

test("a filter in a nested repository or submodule is never consulted (verifier spot-check C2)", {
  skip: process.platform === "win32",
}, async () => {
  const { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync } = await import(
    "node:fs"
  );
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const p = mk({ "top.js": "top\n" });
  // A nested repository added as a gitlink, with its own hostile config.
  const sub = join(p.dir, "sub");
  mkdirSync(sub);
  execFileSync("git", ["init", "-q", "-b", "main", "--template="], { cwd: sub, env: GIT_ENV });
  writeFileSync(join(sub, "f.js"), "one\n");
  writeFileSync(join(sub, ".gitattributes"), "* filter=pwn\n");
  git(sub, "add", "-A");
  git(sub, "commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "sub");
  git(p.dir, "add", "-A");
  git(p.dir, "commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "with gitlink");
  const helper = mk({}, { git: false });
  const marker = join(helper.dir, "PWNED");
  const script = join(helper.dir, "clean.sh");
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
  chmodSync(script, 0o755);
  appendFileSync(join(sub, ".git", "config"), `[filter "pwn"]\n\tclean = ${script}\n`);
  // Same size on purpose: a size change lets git decide "modified" from stat data alone, so whether it hashes
  // the file (and therefore runs the clean filter) would depend on timing. Equal size forces a content check.
  writeFileSync(join(sub, "f.js"), "two\n");

  execFileSync("git", ["diff", "HEAD"], { cwd: p.dir, env: GIT_ENV, stdio: "ignore" });
  assert.equal(
    existsSync(marker),
    true,
    "precondition: a plain git diff in the parent runs the submodule's filter",
  );
  rmSync(marker);

  await resolveTarget({ cwd: p.dir, mode: "changed", ref: null, exclude: EXCL });
  await resolveTarget({ cwd: p.dir, mode: "since", ref: "HEAD", exclude: EXCL });
  assert.equal(existsSync(marker), false, "code-intel must not run a nested repository's filter");
});
