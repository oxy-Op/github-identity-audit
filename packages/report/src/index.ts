import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AuditReport } from "../../core/src/types.ts";

function escape(value: unknown) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export async function writeReports(report: AuditReport, output: string) {
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(output, "report.html"), renderHtml(report));
  const redacted = redactReport(report);
  await writeFile(join(output, "report.redacted.json"), JSON.stringify(redacted, null, 2));
  await writeFile(join(output, "report.redacted.html"), renderHtml(redacted));
}

export function redactReport(report: AuditReport): AuditReport {
  const serialized = JSON.stringify(report).replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/giu, "[redacted-email]");
  const redacted = JSON.parse(serialized) as AuditReport;
  redacted.findings = redacted.findings.filter((finding) => finding.category !== "email");
  redacted.metrics = { ...redacted.metrics, redactedEmailFindings: report.findings.filter((finding) => finding.category === "email").length };
  return redacted;
}

function renderHtml(report: AuditReport) {
  const rows = report.findings.map((finding) => `<article class="finding ${finding.severity}"><div class="meta">${escape(finding.severity.toUpperCase())} · ${escape(finding.category)} · ${(finding.confidence * 100).toFixed(0)}%</div><h2>${escape(finding.summary)}</h2><blockquote>${escape(finding.evidenceSpan)}</blockquote><code>${escape(finding.artifact.path ?? finding.artifact.commitOid ?? finding.artifact.id)}</code></article>`).join("\n");
  const warnings = report.warnings.map((warning) => `<li>${escape(warning.message)}</li>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Identity audit: ${escape(report.target.githubUsername)}</title><style>body{font:16px system-ui;max-width:960px;margin:40px auto;padding:0 20px;color:#17202a;background:#f7f8fa}header,.finding{background:white;border:1px solid #dde2e7;border-radius:12px;padding:20px;margin:16px 0}.finding{border-left:6px solid #8191a2}.finding.high{border-left-color:#c0392b}.finding.medium{border-left-color:#d68910}.meta{font-size:12px;font-weight:700;color:#687784}blockquote{background:#f4f6f7;padding:12px;border-radius:6px}code{overflow-wrap:anywhere}.partial{color:#a04000}</style></head><body><header><h1>GitHub identity audit</h1><p>Target: <strong>${escape(report.target.githubUsername)}</strong></p><p class="${report.complete ? "" : "partial"}">${report.complete ? "Complete within configured scope" : "Partial audit — review warnings"}</p><p>${report.findings.length} findings · ${report.metrics.commitsScanned ?? 0} commits · ${report.metrics.uniqueBlobsScanned ?? 0} unique blobs</p>${warnings ? `<h2>Warnings</h2><ul>${warnings}</ul>` : ""}</header>${rows || "<p>No findings.</p>"}</body></html>`;
  return html;
}
