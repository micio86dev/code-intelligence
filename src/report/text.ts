import type { ScanReport } from "../commands/scan.ts";
import { type EngineResult, SEVERITIES } from "../types.ts";

const TAG: Record<EngineResult["status"], string> = {
  ok: "ok",
  findings: "FOUND",
  skipped: "skip",
  unavailable: "MISSING",
  timeout: "TIMEOUT",
  error: "ERROR",
};

const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

export function renderText(r: ScanReport): string {
  const L: string[] = [];
  const t = r.target;
  const scope = t.mode === "since" ? `since ${t.ref}` : t.mode;
  L.push(
    `${r.tool.name} ${r.tool.version} | profile ${r.profile} | ${scope} | ${t.fileCount} file(s), ${t.excludedCount} excluded | ${secs(r.durationMs)}`,
  );
  L.push("");
  L.push("Engines");
  for (const e of r.engines) {
    const ver = e.version ? ` ${e.version}` : "";
    const detail =
      e.status === "ok" || e.status === "findings"
        ? `${e.findingCount} finding(s)${e.cached ? ", cached" : ""}, ${secs(e.durationMs)}`
        : (e.reason ?? "");
    L.push(`  [${TAG[e.status].padEnd(7)}] ${(e.engine + ver).padEnd(22)} ${detail}`);
    for (const w of e.warnings) L.push(`            warning: ${w}`);
  }
  L.push("");

  if (r.findings.length === 0) {
    L.push("No findings.");
  } else {
    L.push(`Findings (${r.summary.total})`);
    for (const f of r.findings) {
      const loc = f.line === null ? f.file : `${f.file}:${f.line}`;
      L.push(
        `  ${f.severity.toUpperCase().padEnd(8)} ${loc}  [${f.engine}${f.alsoReportedBy.length ? ` +${f.alsoReportedBy.join(",")}` : ""}] ${f.ruleId}`,
      );
      L.push(`           ${f.message}`);
      if (f.remediation) L.push(`           fix: ${f.remediation}`);
    }
  }
  L.push("");

  const counts = SEVERITIES.slice()
    .reverse()
    .filter((s) => r.summary.bySeverity[s] > 0)
    .map((s) => `${r.summary.bySeverity[s]} ${s}`);
  L.push(`Summary: ${counts.length ? counts.join(", ") : "clean"}`);
  const sup = r.summary.suppressed;
  if (sup.outsideChangedLines > 0) {
    L.push(
      `Note: ${sup.outsideChangedLines} SAST finding(s) on unchanged lines were hidden (use --all or set "lineFilter": false to see them).`,
    );
  }
  if (sup.baseline > 0)
    L.push(`Note: ${sup.baseline} finding(s) matched the baseline and were hidden.`);

  if (r.exitCode === 1)
    L.push(`Result: FAIL (exit 1): findings at or above '${r.summary.failOn}'.`);
  else if (r.exitCode === 3)
    L.push(
      "Result: INCOMPLETE (exit 3): no blocking findings, but some checks did not complete. Do not treat this as a pass.",
    );
  else L.push("Result: PASS (exit 0)");
  return `${L.join("\n")}\n`;
}
