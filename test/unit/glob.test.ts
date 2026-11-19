import assert from "node:assert/strict";
import { test } from "node:test";
import { compileGlobs, isSafeGlob } from "../../src/core/glob.ts";

test("bare name matches at any depth and excludes directory contents", () => {
  const m = compileGlobs(["node_modules"]);
  assert.equal(m("node_modules/a/b.js"), true);
  assert.equal(m("packages/x/node_modules/y.js"), true);
  assert.equal(m("src/node_modules_not.js"), false);
});

test("star does not cross slashes, double star does", () => {
  const m = compileGlobs(["src/*.ts", "docs/**/*.md"]);
  assert.equal(m("src/a.ts"), true);
  assert.equal(m("src/deep/a.ts"), false);
  assert.equal(m("docs/a.md"), true);
  assert.equal(m("docs/x/y/a.md"), true);
});

test("extension globs and braces", () => {
  const m = compileGlobs(["*.min.js", "**/*.{png,jpg}"]);
  assert.equal(m("static/app.min.js"), true);
  assert.equal(m("app.js"), false);
  assert.equal(m("img/a/b.png"), true);
  assert.equal(m("img/a/b.gif"), false);
});

test("regex metacharacters in patterns are literal", () => {
  const m = compileGlobs(["a+b(1).txt"]);
  assert.equal(m("a+b(1).txt"), true);
  assert.equal(m("aab1.txt"), false);
});

test("unsafe globs are detected", () => {
  assert.equal(isSafeGlob("../secrets/**"), false);
  assert.equal(isSafeGlob("a/../../b"), false);
  assert.equal(isSafeGlob("/etc/passwd"), false);
  assert.equal(isSafeGlob("C:\\x"), false);
  assert.equal(isSafeGlob("src/**/*.ts"), true);
});
