import assert from "node:assert/strict";
import { test } from "node:test";
import { compileGlobs, globProblem, isSafeGlob } from "../../src/core/glob.ts";

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

test("pathological globs cannot hang the matcher (ReDoS) and are rejected by validation", () => {
  const evil = `${"**/".repeat(14)}a`;
  const t0 = performance.now();
  compileGlobs([evil])(`${"d/".repeat(24)}b`);
  assert.ok(performance.now() - t0 < 500, "repeated ** must be collapsed");
  assert.match(globProblem("**/a/**/b/**/c/**/d") ?? "", /at most 3/);
  assert.match(globProblem("x".repeat(201)) ?? "", /at most 200 characters/);
  assert.match(globProblem("*a*b*c*d*e*f*g*h*i*j*k*l*m") ?? "", /wildcard/);
  assert.equal(globProblem("src/**/*.ts"), null);
  assert.equal(globProblem("../x") !== null, true);
});

test("unbalanced braces are literal and never throw", () => {
  const m = compileGlobs(["a{b", "c}d"]);
  assert.equal(m("a{b"), true);
  assert.equal(m("c}d"), true);
  assert.equal(m("ab"), false);
});

test("verifier repro: 11 stars against a 50-char name returns instantly (linear-time matcher)", () => {
  const evil = "*a*a*a*a*a*a*a*a*a*a*ab";
  const m = compileGlobs([evil]);
  for (const n of [40, 80, 5000]) {
    const t0 = performance.now();
    assert.equal(m("a".repeat(n)), false);
    assert.ok(performance.now() - t0 < 200, `n=${n} took ${performance.now() - t0}ms`);
  }
  // and the same shape with slashes and double stars, which have a different code path
  const g = compileGlobs([`${"**/".repeat(3)}${"*a".repeat(5)}b`]);
  const t1 = performance.now();
  g(`${"a/".repeat(500)}a`);
  assert.ok(performance.now() - t1 < 500);
});

test("matcher semantics: stars, classes, braces, anchoring and directory prefixes", () => {
  const m = compileGlobs([
    "src/**/gen-*.ts",
    "docs/[a-c]?.md",
    "!x",
    "a/{b,c}/d",
    "/rooted.js",
    "lib/",
  ]);
  assert.equal(m("src/gen-a.ts"), true);
  assert.equal(m("src/x/y/gen-b.ts"), true);
  assert.equal(m("src/x/gen.ts"), false);
  assert.equal(m("docs/a1.md"), true);
  assert.equal(m("docs/d1.md"), false);
  assert.equal(m("docs/a/1.md"), false, "? and [] never cross a slash");
  assert.equal(m("a/b/d"), true);
  assert.equal(m("a/c/d/e.txt"), true, "everything beneath a matched directory");
  assert.equal(m("a/x/d"), false);
  assert.equal(m("rooted.js"), true);
  assert.equal(m("sub/rooted.js"), false, "a leading slash anchors at the root");
  assert.equal(m("lib/deep/file.js"), true);
  assert.equal(m("library/file.js"), false);
});

test("a large file list with the default-style excludes is matched quickly", () => {
  const m = compileGlobs([
    ".git",
    "node_modules",
    "vendor",
    "dist",
    "*.min.js",
    "*.map",
    "**/gen/**",
  ]);
  const paths = Array.from(
    { length: 50_000 },
    (_, i) => `packages/pkg${i % 50}/src/deep/dir/file${i}.ts`,
  );
  const t0 = performance.now();
  let hits = 0;
  for (const p of paths) if (m(p)) hits += 1;
  assert.equal(hits, 0);
  assert.ok(performance.now() - t0 < 3000, `took ${performance.now() - t0}ms`);
});

test("verifier repro: a thousand cheap-looking patterns cannot make a scan slow (count and work are bounded)", async () => {
  const { validateConfig } = await import("../../src/core/config.ts");
  const bomb = Array.from(
    { length: 1000 },
    (_, i) => `{a,b}{c,d}{e,f}{g,h}{i,j}${i}*a*a*a*a*a*a*b`,
  );
  const issues = validateConfig({ exclude: bomb }).issues;
  assert.ok(issues.some((i) => i.path === "exclude" && /at most 100 entries/.test(i.message)));
  assert.ok(issues.some((i) => i.path === "exclude" && /at most 64 alternatives/.test(i.message)));
  assert.equal(validateConfig({ exclude: ["generated/**", "**/*.snap"] }).issues.length, 0);
  // Even if validation were bypassed, the matcher aborts instead of running for minutes.
  const m = compileGlobs(bomb);
  const paths = Array.from({ length: 2000 }, (_, i) => `${"d".repeat(90)}${i}.js`);
  const t0 = performance.now();
  assert.throws(() => {
    for (const p of paths) m(p);
  }, /too expensive/);
  assert.ok(performance.now() - t0 < 10_000, `aborted after ${performance.now() - t0}ms`);
});
