import test from "node:test";
import assert from "node:assert/strict";
import { redactReport } from "./index.ts";

test("redacted reports remove email findings and embedded addresses", () => {
  const profile = { githubUsername: "sasha-777", names: ["Sasha"], emails: [] };
  const report: any = { schemaVersion: "0.1", generatedAt: "now", target: profile, aliases: [], source: "x", complete: true, metrics: {}, warnings: [], findings: [{ id: "email", layer: "observed", category: "email", severity: "high", confidence: 1, summary: "private@example.com", evidenceSpan: "private@example.com", artifact: { id: "a", type: "commit", contentHash: "x", repository: "r", provenance: {} }, matches: [] }, { id: "alias", layer: "observed", category: "identity_alias", severity: "medium", confidence: 1, summary: "Sasha", evidenceSpan: "Sasha <private@example.com>", artifact: { id: "b", type: "commit", contentHash: "y", repository: "r", provenance: {} }, matches: [] }] };
  const redacted = redactReport(report);
  assert.equal(redacted.findings.length, 1);
  assert.match(redacted.findings[0].evidenceSpan, /redacted-email/);
  assert.doesNotMatch(JSON.stringify(redacted), /private@example\.com/);
});
