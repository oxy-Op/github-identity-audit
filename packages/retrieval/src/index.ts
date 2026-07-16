import type { Finding } from "../../core/src/types.ts";
import type { Artifact } from "../../core/src/types.ts";
import { createHash } from "node:crypto";

export interface TextChunk { id: string; text: string; heading?: string; tokenEstimate: number; }
export interface EmbeddingProvider { readonly name: string; readonly model?: string; embed(texts: string[]): Promise<number[][]>; }
export interface EmbeddedChunkRecord { chunk: TextChunk; artifact: Artifact; vector: number[]; }
export interface HybridRetrievalHit { artifactId: string; score: number; }

export class DisabledEmbeddingProvider implements EmbeddingProvider {
  readonly name = "disabled";
  async embed(texts: string[]) { return texts.map(() => []); }
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #model: string;
  constructor(options: { endpoint: string; apiKey: string; model: string; name?: string }) { this.#endpoint = options.endpoint; this.#apiKey = options.apiKey; this.#model = options.model; this.model = options.model; this.name = options.name ?? "openai-compatible"; }
  async embed(texts: string[]) {
    const response = await fetch(this.#endpoint, { method: "POST", headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: this.#model, input: texts }), signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Embedding provider ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const result = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
    return (result.data ?? []).sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "local";
  readonly #implementation: (texts: string[]) => Promise<number[][]>;
  constructor(implementation: (texts: string[]) => Promise<number[][]>) { this.#implementation = implementation; }
  embed(texts: string[]) { return this.#implementation(texts); }
}

export function chunkIdentityText(text: string, idPrefix: string, targetTokens = 450): TextChunk[] {
  const maxCharacters = targetTokens * 4;
  const sections = text.split(/(?=^#{1,6}\s+)/m);
  const chunks: TextChunk[] = [];
  for (const section of sections) {
    const heading = section.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim();
    for (let offset = 0; offset < section.length; offset += maxCharacters) {
      const value = section.slice(offset, offset + maxCharacters).trim();
      if (value) chunks.push({ id: `${idPrefix}:${chunks.length}`, text: heading && !value.startsWith("#") ? `${heading}\n${value}` : value, heading, tokenEstimate: Math.ceil(value.length / 4) });
    }
  }
  return chunks;
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index++) { dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2; }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export interface SemanticRetrievalOptions { queries: string[]; maxChunks: number; maxCandidates: number; threshold: number; batchSize?: number; onEmbeddedBatch?: (records: EmbeddedChunkRecord[]) => void | Promise<void>; hybridSearch?: (queries: Array<{ query: string; vector: number[] }>) => Promise<HybridRetrievalHit[]>; }

export async function retrieveSemanticFindings(artifacts: Artifact[], provider: EmbeddingProvider, options: SemanticRetrievalOptions): Promise<Finding[]> {
  if (provider.name === "disabled" || !options.queries.length) return [];
  const chunks: Array<{ chunk: TextChunk; artifact: Artifact }> = [];
  for (const artifact of artifacts) {
    if (!isIdentityBearingArtifact(artifact)) continue;
    for (const chunk of chunkIdentityText(artifact.text, artifact.id)) {
      chunks.push({ chunk, artifact });
      if (chunks.length >= options.maxChunks) break;
    }
    if (chunks.length >= options.maxChunks) break;
  }
  const queryVectors = await provider.embed(options.queries);
  const batchSize = Math.max(1, Math.min(128, options.batchSize ?? 32));
  const scored: Array<{ score: number; chunk: TextChunk; artifact: Artifact }> = [];
  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize), vectors = await provider.embed(batch.map((item) => item.chunk.text));
    await options.onEmbeddedBatch?.(batch.map((item, index) => ({ ...item, vector: vectors[index] ?? [] })));
    for (let index = 0; index < batch.length; index++) {
      const score = Math.max(0, ...queryVectors.map((query) => cosineSimilarity(query, vectors[index] ?? [])));
      scored.push({ score, ...batch[index] });
    }
  }
  const hybridScores = new Map<string, number>();
  for (const hit of await options.hybridSearch?.(options.queries.map((query, index) => ({ query, vector: queryVectors[index] ?? [] }))) ?? []) hybridScores.set(hit.artifactId, Math.max(hit.score, hybridScores.get(hit.artifactId) ?? 0));
  const hybridWeight = options.hybridSearch ? 0.25 : 0;
  return scored.map((item) => ({ ...item, score: item.score * (1 - hybridWeight) + (hybridScores.get(item.artifact.id) ?? 0) * hybridWeight })).filter((item) => item.score >= options.threshold).sort((a, b) => b.score - a.score).slice(0, options.maxCandidates).map(({ score, chunk, artifact }) => {
    const { text: _text, ...artifactReference } = artifact;
    const evidenceSpan = chunk.text.slice(0, 1_200);
    return { id: createHash("sha256").update(`semantic:${chunk.id}`).digest("hex").slice(0, 20), layer: "inferred", category: "semantic_identity", severity: score >= 0.8 ? "medium" : "low", confidence: score, summary: "Semantic retrieval identified an identity-bearing passage requiring adjudication.", evidenceSpan, artifact: artifactReference, matches: [{ kind: "semantic", value: "identity-bearing passage", start: 0, end: evidenceSpan.length, confidence: score }] };
  });
}

function isIdentityBearingArtifact(artifact: Artifact) {
  if (["profile", "issue", "issue_comment", "pull_request", "review", "review_comment", "discussion", "gist", "release"].includes(artifact.type)) return true;
  if (artifact.type === "commit") return artifact.text.length <= 20_000;
  const path = (artifact.path ?? "").toLowerCase();
  return /(^|\/)(readme|about|authors?|contributors?)(\.|$)/.test(path) || /\.(md|mdx|rst|txt)$/.test(path) || /(package\.json|pyproject\.toml|cargo\.toml|setup\.py)$/.test(path);
}

function sourceImportance(finding: Finding) {
  if (finding.artifact.type === "commit") return 0.85;
  const path = (finding.artifact.path ?? "").toLowerCase();
  if (/(^|\/)(readme|about|authors?|contributors?)(\.|$)/.test(path)) return 1;
  if (/(^|\/)(package\.json|pyproject\.toml|cargo\.toml|setup\.py)$/.test(path)) return 0.85;
  if (/\.(md|mdx|rst|txt)$/.test(path)) return 0.7;
  if (/(lock|vendor|min\.js|generated)/.test(path)) return 0.1;
  return 0.45;
}

function identityKey(finding: Finding) {
  const match = finding.matches.find((item) => item.kind === "alias" || item.kind === "attribution" || item.kind === "email" || item.kind === "semantic");
  return match?.value.normalize("NFKC").toLowerCase() ?? finding.category;
}

export function rankFindings(findings: Finding[]): Finding[] {
  findings = deduplicateFindings(findings);
  const repositoriesByIdentity = new Map<string, Set<string>>();
  for (const finding of findings) {
    const key = identityKey(finding);
    const repositories = repositoriesByIdentity.get(key) ?? new Set<string>();
    repositories.add(finding.artifact.repository);
    repositoriesByIdentity.set(key, repositories);
  }
  return findings.map((finding) => {
    const identityMatches = finding.matches.filter((item) => item.kind === "alias" || item.kind === "attribution" || item.kind === "email");
    const urls = finding.matches.filter((item) => item.kind === "url");
    const aliasMatches = identityMatches.filter((item) => item.kind === "alias");
    const aliasOnlyInUrl = aliasMatches.length > 0 && aliasMatches.every((alias) => urls.some((url) => alias.start >= url.start && alias.end <= url.end));
    const exactAlias = Math.max(0, ...identityMatches.map((item) => item.confidence));
    const attributionContext = finding.category === "self_attribution" ? 1 : 0;
    const artifactAuthorship = finding.artifact.type === "commit" ? 1 : 0;
    const importance = sourceImportance(finding);
    const repositoryCount = repositoriesByIdentity.get(identityKey(finding))?.size ?? 1;
    const corroboration = Math.min(1, repositoryCount / 4);
    const urlOnlyPenalty = aliasOnlyInUrl ? 0.45 : 0;
    const total = Math.max(0, Math.min(1, exactAlias * 0.35 + attributionContext * 0.25 + artifactAuthorship * 0.15 + importance * 0.15 + corroboration * 0.1 - urlOnlyPenalty));
    const highRiskEmail = finding.category === "email" && (exactAlias === 1 || finding.artifact.type === "commit");
    const severity: Finding["severity"] = highRiskEmail || total >= 0.8 ? "high" : total >= 0.55 ? "medium" : "low";
    return { ...finding, confidence: total, severity, score: { exactAlias, attributionContext, artifactAuthorship, sourceImportance: importance, corroboration, urlOnlyPenalty, total } };
  }).sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
}

export function deduplicateFindings(findings: Finding[]): Finding[] {
  const grouped = new Map<string, Finding>();
  for (const finding of findings) {
    const value = identityKey(finding);
    const location = finding.artifact.type === "commit" ? "commit-identity" : finding.artifact.path ?? finding.artifact.id;
    const evidence = finding.artifact.type === "commit" ? "" : finding.evidenceSpan.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
    const key = [finding.category, finding.artifact.repository, location, value, evidence].join("\u0000");
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...finding, artifact: { ...finding.artifact, provenance: { ...finding.artifact.provenance, corroboratingArtifactIds: [finding.artifact.id] } }, matches: [...finding.matches] });
      continue;
    }
    const ids = existing.artifact.provenance.corroboratingArtifactIds as string[];
    if (!ids.includes(finding.artifact.id)) ids.push(finding.artifact.id);
    existing.artifact.occurrences = [...(existing.artifact.occurrences ?? []), ...(finding.artifact.occurrences ?? [])];
    for (const match of finding.matches) if (existing.matches.length < 100 && !existing.matches.some((item) => item.kind === match.kind && item.value === match.value && item.start === match.start)) existing.matches.push(match);
  }
  for (const finding of grouped.values()) {
    const count = (finding.artifact.provenance.corroboratingArtifactIds as string[]).length;
    if (count > 1) finding.summary += ` Corroborated in ${count} historical artifacts.`;
  }
  const uniqueById = new Map<string, Finding>();
  for (const finding of grouped.values()) {
    const existing = uniqueById.get(finding.id);
    if (!existing) { uniqueById.set(finding.id, finding); continue; }
    const ids = new Set([...(existing.artifact.provenance.corroboratingArtifactIds as string[] ?? []), ...(finding.artifact.provenance.corroboratingArtifactIds as string[] ?? [])]);
    existing.artifact.provenance.corroboratingArtifactIds = [...ids];
    existing.artifact.occurrences = [...(existing.artifact.occurrences ?? []), ...(finding.artifact.occurrences ?? [])];
    for (const match of finding.matches) if (!existing.matches.some((item) => item.kind === match.kind && item.value === match.value && item.start === match.start && item.end === match.end)) existing.matches.push(match);
  }
  return [...uniqueById.values()];
}
