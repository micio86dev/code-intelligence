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

// ---- gaps found by mutation testing (code-intel mutate src/core/glob.ts): behavior the first tests never pinned ----

test("braces: nesting, empty alternatives, and unbalanced/misordered braces", () => {
  const nested = compileGlobs(["x/{a,{b,c}}/y"]);
  for (const ok of ["x/a/y", "x/b/y", "x/c/y"]) assert.equal(nested(ok), true, ok);
  assert.equal(nested("x/d/y"), false);
  assert.equal(nested("x/{b,c}/y"), false, "the braces are consumed, not literal");
  const empty = compileGlobs(["a{,b}c"]);
  assert.equal(empty("ac"), true, "an empty alternative is allowed");
  assert.equal(empty("abc"), true);
  assert.equal(empty("a-c"), false);
  // counts are equal but the order is wrong: no group, so everything is literal
  const misordered = compileGlobs(["}a{"]);
  assert.equal(misordered("}a{"), true);
  assert.equal(misordered("a"), false);
  // an opening brace with no closing partner after it
  const dangling = compileGlobs(["a{b}c}{"]);
  assert.equal(dangling("abc}{"), true, "first group expands, the stray pair stays literal");
});

test("brace expansion cap: exactly 32 alternatives is allowed, 33 is not", () => {
  const five = "{a,b}{c,d}{e,f}{g,h}{i,j}"; // 2^5 = 32
  assert.equal(globProblem(five), null);
  assert.equal(compileGlobs([five])("acegi"), true);
  assert.equal(compileGlobs([five])("bdfhj"), true);
  const thirtyThree = "{a,b,c}{1,2,3,4,5,6,7,8,9,10,11}"; // 3 x 11 = 33
  assert.match(globProblem(thirtyThree) ?? "", /more than 32 brace alternatives/);
  assert.equal(globProblem("{a,b,c}{1,2,3,4,5,6,7,8,9,10}"), null, "30 is fine");
});

test("double star: `**` spans slashes, `**/` is zero or more directories, `*` never crosses one", () => {
  const m = compileGlobs(["a/**", "b/**/c", "**/d", "e/*/f"]);
  assert.equal(m("a/x/y/z"), true);
  assert.equal(m("a"), false, "a/** needs the directory itself plus a separator");
  assert.equal(m("b/c"), true, "zero directories");
  assert.equal(m("b/x/c"), true);
  assert.equal(m("b/x/y/c"), true);
  assert.equal(m("b/xc"), false, "the directory part must end at a slash");
  assert.equal(m("d"), true);
  assert.equal(m("x/y/d"), true);
  assert.equal(m("x/yd"), false);
  assert.equal(m("e/x/f"), true);
  assert.equal(m("e/x/y/f"), false, "a single star stays inside one segment");
  assert.equal(compileGlobs(["src/**"])("src/"), true);
});

test("character classes: ranges, negation with ! and ^, and an unterminated bracket", () => {
  const range = compileGlobs(["x/[a-c]1"]);
  assert.equal(range("x/a1"), true);
  assert.equal(range("x/c1"), true);
  assert.equal(range("x/d1"), false);
  assert.equal(range("x/-1"), false);
  for (const neg of ["x/[!a-c]1", "x/[^a-c]1"]) {
    const m = compileGlobs([neg]);
    assert.equal(m("x/d1"), true, neg);
    assert.equal(m("x/b1"), false, neg);
    assert.equal(m("x//1"), false, "a negated class still never matches a slash");
  }
  const lit = compileGlobs(["x/a-c]"]);
  assert.equal(lit("x/a-c]"), true, "a stray closing bracket is literal");
  const open = compileGlobs(["x/[abc"]);
  assert.equal(open("x/[abc"), true, "an unterminated class is literal");
  assert.equal(open("x/a"), false);
  const multi = compileGlobs(["[abc-e]z", "q[x]"]);
  assert.equal(multi("dz"), true);
  assert.equal(multi("fz"), false);
  assert.equal(multi("qx"), true);
  assert.equal(compileGlobs(["[!]]x"])("ax"), false, "malformed classes never throw");
});

test("star and question mark: bare-name fast paths and the general path agree", () => {
  const m = compileGlobs(["*.min.js", "build?", "a*b"]);
  assert.equal(m("lib/app.min.js"), true);
  assert.equal(m("app.js"), false);
  assert.equal(m("x/build1/y"), true);
  assert.equal(m("x/build/y"), false, "? needs exactly one character");
  assert.equal(m("x/build12"), false);
  assert.equal(m("deep/aXXb/c"), true);
  assert.equal(m("deep/a/b"), false, "* never crosses a slash");
  assert.equal(
    compileGlobs(["*"])("anything/at/all"),
    true,
    "a bare * matches every first segment",
  );
});

test("normalization: ./ prefix, trailing slash, backslashes, leading slash anchoring", () => {
  assert.equal(compileGlobs(["./src/gen"])("src/gen/x.ts"), true);
  assert.equal(compileGlobs(["src/gen/"])("src/gen/x.ts"), true);
  assert.equal(compileGlobs(["src\\gen"])("src/gen/x.ts"), true, "Windows separators are accepted");
  assert.equal(compileGlobs(["/gen"])("gen/x"), true);
  assert.equal(compileGlobs(["/gen"])("src/gen/x"), false, "a leading slash anchors at the root");
  assert.equal(compileGlobs(["gen"])("src/gen/x"), true, "a bare name matches at any depth");
});

test("globProblem boundaries: length, double stars, wildcard count, safety", () => {
  assert.equal(globProblem("a".repeat(200)), null);
  assert.match(globProblem("a".repeat(201)) ?? "", /at most 200/);
  assert.equal(globProblem("**/a/**/b/**/c"), null, "three ** are fine");
  assert.match(globProblem("**/a/**/b/**/c/**/d") ?? "", /at most 3/);
  assert.equal(globProblem("**/**/**/**/a"), null, "repeated **/ collapse to one");
  assert.equal(globProblem("*a*b*c*d*e*f*g*h*i*j*k*l"), null, "exactly 12 wildcards");
  assert.match(globProblem("*a*b*c*d*e*f*g*h*i*j*k*l*m") ?? "", /at most 12 wildcard/);
  assert.match(globProblem("..") ?? "", /must be relative/);
  assert.match(globProblem("a/../b") ?? "", /must be relative/);
  assert.equal(isSafeGlob("a..b"), true, "only a whole `..` segment is traversal");
  assert.equal(isSafeGlob("C:\\x"), false);
  assert.equal(isSafeGlob("a/b"), true);
});

test("totalAlternatives counts expansions and caps runaway input", async () => {
  const { totalAlternatives } = await import("../../src/core/glob.ts");
  assert.equal(totalAlternatives(["a", "b"]), 2);
  assert.equal(totalAlternatives(["{a,b}x", "y"]), 3);
  assert.ok(
    totalAlternatives(["{a,b,c}{1,2,3,4,5,6,7,8,9,10,11}"]) > 32,
    "over-limit patterns count as exceeding the cap",
  );
});
