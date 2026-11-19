import type { ScanReport } from "../commands/scan.ts";
import type { Severity } from "../types.ts";

const LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  critical: "error",
  high: "error",
  medium: "warning",
  low: "note",
  info: "note",
};

/** SARIF 2.1.0, consumable by GitHub code scanning and most IDEs. */
export function renderSarif(r: ScanReport): string {
  const rules = new Map<
    string,
    { id: string; name: string; helpUri?: string; properties: { tags: string[] } }
  >();
  for (const f of r.findings) {
    if (rules.has(f.ruleId)) continue;
    const rule: { id: string; name: string; helpUri?: string; properties: { tags: string[] } } = {
      id: f.ruleId,
      name: f.ruleId.split(".").slice(-1)[0] ?? f.ruleId,
      properties: { tags: [f.category, f.engine] },
    };
    if (f.references[0]) rule.helpUri = f.references[0];
    rules.set(f.ruleId, rule);
  }
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: r.tool.name,
            version: r.tool.version,
            informationUri: "https://github.com/micio86dev/code-intelligence",
            rules: [...rules.values()],
          },
        },
        invocations: [
          {
            executionSuccessful: r.complete,
            toolExecutionNotifications: r.engines
              .filter(
                (e) => e.status === "timeout" || e.status === "error" || e.status === "unavailable",
              )
              .map((e) => ({
                level: "error",
                message: { text: e.reason ?? `${e.engine}: ${e.status}` },
                properties: { engine: e.engine },
              })),
          },
        ],
        results: r.findings.map((f) => ({
          ruleId: f.ruleId,
          level: LEVEL[f.severity],
          message: { text: f.remediation ? `${f.message} ${f.remediation}` : f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.file, uriBaseId: "%SRCROOT%" },
                ...(f.line !== null
                  ? { region: { startLine: f.line, endLine: f.endLine ?? f.line } }
                  : {}),
              },
            },
          ],
          partialFingerprints: { "codeIntel/v1": f.fingerprint },
          properties: { engine: f.engine, category: f.category, severity: f.severity },
        })),
      },
    ],
  };
  return `${JSON.stringify(sarif, null, 2)}\n`;
}
