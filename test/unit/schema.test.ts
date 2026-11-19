import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { defaultConfig, validateConfig } from "../../src/core/config.ts";
import { CATEGORIES, SEVERITIES } from "../../src/types.ts";

const load = (n: string) =>
  JSON.parse(readFileSync(new URL(`../../schema/${n}`, import.meta.url), "utf8"));
const configSchema = load("config.schema.json");
const reportSchema = load("report.schema.json");

test("config schema lists exactly the keys the validator accepts", () => {
  const schemaKeys = Object.keys(configSchema.properties).sort();
  // Probe the validator: every schema key must be accepted, and an unknown key must be rejected.
  const accepted = schemaKeys.filter(
    (k) =>
      k === "$schema" ||
      !validateConfig({ [k]: undefined }).issues.some(
        (i) => i.message === "unknown key" && i.path === k,
      ),
  );
  assert.deepEqual(accepted, schemaKeys);
  assert.equal(validateConfig({ definitelyNotAKey: 1 }).issues[0]?.message, "unknown key");
});

test("config schema defaults match the code defaults", () => {
  const d = defaultConfig();
  assert.equal(configSchema.properties.failOn.default, d.failOn);
  assert.equal(configSchema.properties.baseline.default, d.baseline);
  assert.equal(configSchema.properties.lineFilter.default, d.lineFilter);
  assert.equal(configSchema.properties.allowMissingEngines.default, d.allowMissingEngines);
  assert.deepEqual(
    configSchema.properties.engines.properties.semgrep.properties.configs.default,
    d.engines.semgrep.configs,
  );
});

test("report schema enums match the code's severities and categories", () => {
  assert.deepEqual(reportSchema.definitions.finding.properties.severity.enum, [...SEVERITIES]);
  assert.deepEqual(reportSchema.definitions.finding.properties.category.enum, [...CATEGORIES]);
  assert.deepEqual(reportSchema.properties.summary.properties.failOn.enum, [...SEVERITIES]);
});
