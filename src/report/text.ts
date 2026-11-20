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

/** Escape control characters: file names and messages come from the scanned repository and could forge report lines or move the cursor. */
export function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, (c) => {
    if (c === "\n") return "\\n";
    if (c === "\t") return "\\t";
    if (c === "\r") return "\\r";
    return `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`;
  });
}

const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

export function renderText(r: ScanReport): string {
  const L: string[] = [];
  const t = r.target;
  const scope = t.mode === "since" ? `since ${clean(t.ref ?? "")}` : t.mode;
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
        : clean(e.reason ?? "");
    L.push(`  [${TAG[e.status].padEnd(7)}] ${(e.engine + ver).padEnd(22)} ${detail}`);
    for (const w of e.warnings) L.push(`            warning: ${clean(w)}`);
  }
  L.push("");

  if (r.findings.length === 0) {
    L.push("No findings.");
  } else {
    L.push(`Findings (${r.summary.total})`);
    for (const f of r.findings) {
      const loc = clean(f.line === null ? f.file : `${f.file}:${f.line}`);
      L.push(
        `  ${f.severity.toUpperCase().padEnd(8)} ${loc}  [${f.engine}${f.alsoReportedBy.length ? ` +${f.alsoReportedBy.join(",")}` : ""}] ${clean(f.ruleId)}`,
      );
      L.push(`           ${clean(f.message)}`);
      if (f.remediation) L.push(`           fix: ${clean(f.remediation)}`);
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
  if (r.config.ignored) {
    L.push("Note: the repository's own configuration was ignored (--ignore-repo-config).");
  } else if (r.config.inEffect.length > 0) {
    L.push(
      `Note: repository-supplied configuration is in effect: ${r.config.inEffect.map(clean).join("; ")}. A repository can configure a scan to find less; use --ignore-repo-config for code you do not trust.`,
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
