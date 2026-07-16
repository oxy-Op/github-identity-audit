import test from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "../../core/src/types.ts";
import { chunkIdentityText, cosineSimilarity, deduplicateFindings, DisabledEmbeddingProvider, LocalEmbeddingProvider, rankFindings, retrieveSemanticFindings } from "./index.ts";

function finding(path: string, matchStart: number, url = false): Finding {
  return { id: path, layer: "observed", category: "identity_alias", severity: "medium", confidence: 1, summary: "Sasha", evidenceSpan: "Sasha", artifact: { id: path, type: "git_blob", contentHash: path, repository: path, path, provenance: {} }, matches: [{ kind: "alias", value: "Sasha", start: matchStart, end: matchStart + 5, confidence: 1 }, ...(url ? [{ kind: "url" as const, value: "https://github.com/Sasha", start: 0, end: 24, confidence: 0.4 }] : [])] };
}

test("ranks README prose above an alias that only occurs in a URL", () => {
  const ranked = rankFindings([finding("src/code.ts", 19, true), finding("README.md", 0)]);
  assert.equal(ranked[0].artifact.path, "README.md");
  assert.ok(ranked[0].confidence > ranked[1].confidence);
});

test("chunks identity prose with headings and supports disabled embeddings", async () => {
  const chunks = chunkIdentityText("# About\n" + "Personal biography. ".repeat(200), "artifact", 100);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].heading, "About");
  assert.deepEqual(await new DisabledEmbeddingProvider().embed(["one", "two"]), [[], []]);
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
});

test("treats an unknown email in prose less severely than commit identity metadata", () => {
  const prose: Finding = { ...finding("README.md", 0), category: "email", matches: [{ kind: "email", value: "third@example.com", start: 0, end: 17, confidence: 0.92 }] };
  const commit: Finding = { ...prose, id: "commit", artifact: { ...prose.artifact, id: "commit", type: "commit", commitOid: "abc" } };
  const ranked = rankFindings([prose, commit]);
  assert.equal(ranked.find((item) => item.id === "commit")?.severity, "high");
  assert.notEqual(ranked.find((item) => item.id === "README.md")?.severity, "high");
});

test("collapses repeated historical evidence while preserving corroborating IDs", () => {
  const one = finding("README.md", 0);
  const two = { ...finding("README.md", 0), id: "second", artifact: { ...one.artifact, id: "blob:second", contentHash: "second" } };
  const result = deduplicateFindings([one, two]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].artifact.provenance.corroboratingArtifactIds, ["README.md", "blob:second"]);
});

test("enforces unique finding IDs across independently collected copies", () => {
  const one = finding("README.md", 0);
  const copy = { ...finding("elsewhere.md", 0), id: one.id, artifact: { ...one.artifact, repository: "other-copy" } };
  const result = deduplicateFindings([one, copy]);
  assert.equal(result.length, 1);
  assert.equal(new Set(result.map((item) => item.id)).size, result.length);
});

test("retrieves bounded semantic identity candidates", async () => {
  const provider = new LocalEmbeddingProvider(async (texts) => texts.map((text) => /identity|name/i.test(text) ? [1, 0] : [0, 1]));
  const artifacts = [{ id: "profile", type: "profile" as const, text: "My identity and name", contentHash: "x", repository: "demo", provenance: {} }];
  const findings = await retrieveSemanticFindings(artifacts, provider, { queries: ["identity"], maxChunks: 10, maxCandidates: 1, threshold: 0.7 });
  assert.equal(findings[0].category, "semantic_identity");
  assert.equal(findings.length, 1);
});
