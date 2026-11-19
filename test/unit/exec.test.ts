import assert from "node:assert/strict";
import { test } from "node:test";
import { chunkByLength, exec, findBinary } from "../../src/core/exec.ts";

const node = process.execPath;
const cwd = process.cwd();

test("captures stdout, stderr and exit code", async () => {
  const r = await exec(node, ["-e", "console.log('out');console.error('err');process.exit(3)"], {
    cwd,
    timeoutMs: 10_000,
  });
  assert.equal(r.stdout.trim(), "out");
  assert.equal(r.stderr.trim(), "err");
  assert.equal(r.code, 3);
  assert.equal(r.timedOut, false);
});

test("kills the process on timeout and reports it", async () => {
  const t0 = Date.now();
  const r = await exec(node, ["-e", "setInterval(()=>{},1000)"], { cwd, timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 5000, "must not wait for the child to finish");
});

test("kills grandchildren (process group) on timeout", async () => {
  if (process.platform === "win32") return;
  const script = `
    const { spawn } = require('node:child_process');
    const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    console.log(c.pid);
    setInterval(()=>{},1000);
  `;
  const r = await exec(node, ["-e", script], { cwd, timeoutMs: 800 });
  const grandchild = Number(r.stdout.trim());
  assert.ok(Number.isInteger(grandchild) && grandchild > 0);
  await new Promise((res) => setTimeout(res, 200));
  let alive = true;
  try {
    process.kill(grandchild, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "grandchild must be dead");
});

test("missing binary yields spawnError, not a throw", async () => {
  const r = await exec("definitely-not-a-real-binary-xyz", [], { cwd, timeoutMs: 2000 });
  assert.equal(r.spawnError?.code, "ENOENT");
});

test("arguments are never interpreted by a shell", async () => {
  const r = await exec(node, ["-p", "process.argv[1]", "$(echo pwned); `id` | cat"], {
    cwd,
    timeoutMs: 10_000,
  });
  assert.equal(r.stdout.trim(), "$(echo pwned); `id` | cat");
});

test("output cap truncates and kills runaway producers", async () => {
  const r = await exec(node, ["-e", "setInterval(()=>process.stdout.write('x'.repeat(65536)),1)"], {
    cwd,
    timeoutMs: 10_000,
    maxBytes: 200_000,
  });
  assert.equal(r.truncated, true);
});

test("findBinary locates node and rejects nonsense", () => {
  assert.ok(findBinary("node"));
  assert.equal(findBinary("definitely-not-a-real-binary-xyz"), null);
});

test("chunkByLength respects the budget", () => {
  const items = Array.from({ length: 10 }, (_, i) => `file-${i}.ts`);
  const chunks = chunkByLength(items, 30);
  assert.equal(chunks.flat().length, 10);
  for (const c of chunks) assert.ok(c.join(" ").length <= 31);
});

test("unsetEnv removes inherited variables from the child", async () => {
  process.env.CI_TEST_LEAK = "yes";
  try {
    const kept = await exec(node, ["-p", "process.env.CI_TEST_LEAK ?? 'unset'"], {
      cwd,
      timeoutMs: 10_000,
    });
    const removed = await exec(node, ["-p", "process.env.CI_TEST_LEAK ?? 'unset'"], {
      cwd,
      timeoutMs: 10_000,
      unsetEnv: ["CI_TEST_LEAK"],
    });
    assert.equal(kept.stdout.trim(), "yes");
    assert.equal(removed.stdout.trim(), "unset");
  } finally {
    delete process.env.CI_TEST_LEAK;
  }
});
