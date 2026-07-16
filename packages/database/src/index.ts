import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Artifact, AuditReport, Finding, IdentityAlias, IdentityProfile, ScanWarning } from "../../core/src/types.ts";
import type { LlmUsage } from "../../budget/src/index.ts";
import type { EmbeddedChunkRecord } from "../../retrieval/src/index.ts";
import { extractRuleSignals } from "../../extractors/src/index.ts";

export interface HybridSearchResult {
  artifactId: string;
  chunkId?: string;
  repository: string | null;
  type: string;
  text: string;
  lexicalScore: number;
  semanticScore: number;
  score: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS audits (id TEXT PRIMARY KEY, source TEXT NOT NULL, status TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, finished_at TEXT, metrics_json TEXT);
CREATE TABLE IF NOT EXISTS targets (id TEXT PRIMARY KEY, audit_id TEXT NOT NULL REFERENCES audits(id), github_username TEXT NOT NULL, profile_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS identity_aliases (audit_id TEXT NOT NULL REFERENCES audits(id), normalized TEXT NOT NULL, value TEXT NOT NULL, origin TEXT NOT NULL, confidence REAL NOT NULL, PRIMARY KEY(audit_id, normalized));
CREATE TABLE IF NOT EXISTS repositories (audit_id TEXT NOT NULL REFERENCES audits(id), repository_id TEXT NOT NULL, full_name TEXT NOT NULL, clone_url TEXT, metadata_json TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(audit_id, repository_id));
CREATE TABLE IF NOT EXISTS git_objects (repository_id TEXT NOT NULL, oid TEXT NOT NULL, type TEXT NOT NULL, byte_size INTEGER, scanned_at TEXT NOT NULL, extractor_version TEXT NOT NULL, PRIMARY KEY(repository_id, oid, type));
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, audit_id TEXT NOT NULL REFERENCES audits(id), type TEXT NOT NULL, content_hash TEXT NOT NULL, repository TEXT, text TEXT NOT NULL, provenance_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifact_occurrences (artifact_id TEXT NOT NULL REFERENCES artifacts(id), repository TEXT NOT NULL, path TEXT, commit_oid TEXT, PRIMARY KEY(artifact_id, repository, path, commit_oid));
CREATE TABLE IF NOT EXISTS extracted_entities (id INTEGER PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id), kind TEXT NOT NULL, value TEXT NOT NULL, normalized TEXT, confidence REAL);
CREATE TABLE IF NOT EXISTS extracted_links (id INTEGER PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id), url TEXT NOT NULL, domain TEXT);
CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id), text TEXT NOT NULL, token_estimate INTEGER, metadata_json TEXT);
CREATE TABLE IF NOT EXISTS embeddings (chunk_id TEXT NOT NULL REFERENCES chunks(id), provider TEXT NOT NULL, model TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(chunk_id, provider, model));
CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, audit_id TEXT NOT NULL REFERENCES audits(id), artifact_id TEXT REFERENCES artifacts(id), score REAL NOT NULL, score_json TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS findings (id TEXT PRIMARY KEY, audit_id TEXT NOT NULL REFERENCES audits(id), artifact_id TEXT, layer TEXT NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, confidence REAL NOT NULL, summary TEXT NOT NULL, evidence_span TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS finding_evidence (finding_id TEXT NOT NULL REFERENCES findings(id), position INTEGER NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, confidence REAL NOT NULL, PRIMARY KEY(finding_id, position));
CREATE TABLE IF NOT EXISTS llm_runs (id TEXT PRIMARY KEY, audit_id TEXT NOT NULL REFERENCES audits(id), provider TEXT NOT NULL, model TEXT NOT NULL, status TEXT NOT NULL, usage_json TEXT, result_json TEXT);
CREATE TABLE IF NOT EXISTS budget_transactions (id TEXT PRIMARY KEY, audit_id TEXT NOT NULL REFERENCES audits(id), kind TEXT NOT NULL, amount_usd REAL, input_tokens INTEGER, output_tokens INTEGER, metadata_json TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scan_warnings (id INTEGER PRIMARY KEY, audit_id TEXT NOT NULL REFERENCES audits(id), code TEXT NOT NULL, message TEXT NOT NULL, count INTEGER);
CREATE INDEX IF NOT EXISTS artifacts_hash_idx ON artifacts(content_hash);
CREATE INDEX IF NOT EXISTS findings_audit_idx ON findings(audit_id, severity, confidence);
CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(artifact_id UNINDEXED, text);
`;

export class AuditDatabase {
  readonly #db: DatabaseSync;
  readonly auditId: string;

  private constructor(path: string, auditId: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(SCHEMA);
    this.auditId = auditId;
  }

  static async create(path: string, source: string, profile: IdentityProfile, aliases: IdentityAlias[]) {
    await mkdir(dirname(path), { recursive: true });
    const auditId = crypto.randomUUID();
    const store = new AuditDatabase(path, auditId);
    const now = new Date().toISOString();
    store.#db.prepare("INSERT INTO audits(id, source, status, started_at) VALUES (?, ?, 'running', ?)").run(auditId, source, now);
    store.#db.prepare("INSERT INTO targets(id, audit_id, github_username, profile_json) VALUES (?, ?, ?, ?)").run(`target:${auditId}`, auditId, profile.githubUsername, JSON.stringify(profile));
    const insertAlias = store.#db.prepare("INSERT INTO identity_aliases(audit_id, normalized, value, origin, confidence) VALUES (?, ?, ?, ?, ?)");
    for (const alias of aliases) insertAlias.run(auditId, alias.normalized, alias.value, alias.origin, alias.confidence);
    return store;
  }

  recordRepository(repository: { id: number; fullName: string; cloneUrl: string }, status = "selected") {
    this.#db.prepare("INSERT OR REPLACE INTO repositories(audit_id, repository_id, full_name, clone_url, metadata_json, status) VALUES (?, ?, ?, ?, ?, ?)").run(this.auditId, String(repository.id), repository.fullName, repository.cloneUrl, JSON.stringify(repository), status);
  }

  setRepositoryStatus(repositoryId: number, status: string) {
    this.#db.prepare("UPDATE repositories SET status = ? WHERE audit_id = ? AND repository_id = ?").run(status, this.auditId, String(repositoryId));
  }

  recordArtifacts(artifacts: Artifact[]) {
    const insertArtifact = this.#db.prepare("INSERT OR IGNORE INTO artifacts(id, audit_id, type, content_hash, repository, text, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertOccurrence = this.#db.prepare("INSERT OR IGNORE INTO artifact_occurrences(artifact_id, repository, path, commit_oid) VALUES (?, ?, ?, ?)");
    const insertFts = this.#db.prepare("INSERT INTO artifact_fts(artifact_id, text) VALUES (?, ?)");
    this.#db.exec("BEGIN");
    try {
      for (const artifact of artifacts) {
        const databaseId = `${this.auditId}:${artifact.id}`;
        const result = insertArtifact.run(databaseId, this.auditId, artifact.type, artifact.contentHash, artifact.repository, artifact.text, JSON.stringify(artifact.provenance));
        const occurrences = artifact.occurrences?.length ? artifact.occurrences : [{ path: artifact.path ?? "", commitOid: artifact.commitOid ?? "" }];
        for (const occurrence of occurrences) insertOccurrence.run(databaseId, artifact.repository, occurrence.path, occurrence.commitOid);
        if (result.changes) insertFts.run(databaseId, artifact.text);
      }
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  recordExtractionSignals(artifacts: Artifact[], profile: Pick<IdentityProfile, "names" | "organizations" | "locations">) {
    const insertEntity = this.#db.prepare("INSERT INTO extracted_entities(artifact_id, kind, value, normalized, confidence) VALUES (?, ?, ?, ?, ?)");
    const insertLink = this.#db.prepare("INSERT INTO extracted_links(artifact_id, url, domain) VALUES (?, ?, ?)");
    this.#db.exec("BEGIN");
    try {
      for (const artifact of artifacts) {
        const artifactId = `${this.auditId}:${artifact.id}`;
        const signals = extractRuleSignals(artifact.text, profile);
        for (const entity of signals.entities) insertEntity.run(artifactId, entity.kind, entity.value, entity.normalized, entity.confidence);
        for (const link of signals.links) insertLink.run(artifactId, link.url, link.domain);
      }
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  recordChunkEmbeddings(records: EmbeddedChunkRecord[], provider: string, model: string) {
    const insertChunk = this.#db.prepare("INSERT OR REPLACE INTO chunks(id, artifact_id, text, token_estimate, metadata_json) VALUES (?, ?, ?, ?, ?)");
    const insertEmbedding = this.#db.prepare("INSERT OR REPLACE INTO embeddings(chunk_id, provider, model, vector) VALUES (?, ?, ?, ?)");
    this.#db.exec("BEGIN");
    try {
      for (const record of records) {
        const chunkId = `${this.auditId}:${record.chunk.id}`;
        insertChunk.run(chunkId, `${this.auditId}:${record.artifact.id}`, record.chunk.text, record.chunk.tokenEstimate, JSON.stringify({ heading: record.chunk.heading }));
        insertEmbedding.run(chunkId, provider, model, encodeVector(record.vector));
      }
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  searchHybrid(query: string, queryVector: number[], provider: string, model: string, limit = 20): HybridSearchResult[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Hybrid result limit must be between 1 and 500");
    const lexicalQuery = [...new Set(query.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    const lexical = lexicalQuery ? this.searchArtifacts(lexicalQuery, Math.min(500, limit * 5)) : [];
    const lexicalScores = new Map(lexical.map((row, index) => [row.id, 1 / (index + 1)]));
    const rows = this.#db.prepare(`SELECT chunks.id AS chunk_id, chunks.artifact_id, chunks.text, artifacts.repository, artifacts.type, embeddings.vector
      FROM embeddings JOIN chunks ON chunks.id = embeddings.chunk_id JOIN artifacts ON artifacts.id = chunks.artifact_id
      WHERE artifacts.audit_id = ? AND embeddings.provider = ? AND embeddings.model = ?`).all(this.auditId, provider, model) as Array<{ chunk_id: string; artifact_id: string; text: string; repository: string | null; type: string; vector: Uint8Array }>;
    const combined = new Map<string, HybridSearchResult>();
    for (const row of rows) {
      const semanticScore = Math.max(0, cosineSimilarity(queryVector, decodeVector(row.vector)));
      const lexicalScore = lexicalScores.get(row.artifact_id) ?? 0;
      const score = semanticScore * 0.7 + lexicalScore * 0.3;
      const current = combined.get(row.artifact_id);
      if (!current || score > current.score) combined.set(row.artifact_id, { artifactId: row.artifact_id.slice(this.auditId.length + 1), chunkId: row.chunk_id.slice(this.auditId.length + 1), repository: row.repository, type: row.type, text: row.text, lexicalScore, semanticScore, score });
    }
    for (const row of lexical) if (!combined.has(row.id)) combined.set(row.id, { artifactId: row.id.slice(this.auditId.length + 1), repository: row.repository, type: row.type, text: row.snippet, lexicalScore: lexicalScores.get(row.id) ?? 0, semanticScore: 0, score: (lexicalScores.get(row.id) ?? 0) * 0.3 });
    return [...combined.values()].sort((left, right) => right.score - left.score).slice(0, limit);
  }

  finish(report: AuditReport) {
    const insertFinding = this.#db.prepare("INSERT OR REPLACE INTO findings(id, audit_id, artifact_id, layer, category, severity, confidence, summary, evidence_span) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertEvidence = this.#db.prepare("INSERT OR REPLACE INTO finding_evidence(finding_id, position, kind, value, start_offset, end_offset, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const insertWarning = this.#db.prepare("INSERT INTO scan_warnings(audit_id, code, message, count) VALUES (?, ?, ?, ?)");
    this.#db.exec("BEGIN");
    try {
      for (const finding of report.findings) this.#recordFinding(finding, insertFinding, insertEvidence);
      for (const warning of report.warnings) insertWarning.run(this.auditId, warning.code, warning.message, warning.count ?? null);
      this.#db.prepare("UPDATE audits SET status = 'completed', complete = ?, finished_at = ?, metrics_json = ? WHERE id = ?").run(report.complete ? 1 : 0, report.generatedAt, JSON.stringify(report.metrics), this.auditId);
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  searchArtifacts(query: string, limit = 20): Array<{ id: string; repository: string | null; type: string; snippet: string; score: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("FTS result limit must be between 1 and 500");
    return this.#db.prepare(`SELECT artifacts.id, artifacts.repository, artifacts.type, snippet(artifact_fts, 1, '[', ']', '…', 24) AS snippet, bm25(artifact_fts) AS score FROM artifact_fts JOIN artifacts ON artifacts.id = artifact_fts.artifact_id WHERE artifact_fts MATCH ? AND artifacts.audit_id = ? ORDER BY score LIMIT ?`).all(query, this.auditId, limit) as Array<{ id: string; repository: string | null; type: string; snippet: string; score: number }>;
  }

  getCachedArtifactText(contentHash: string) {
    const row = this.#db.prepare("SELECT text FROM artifacts WHERE content_hash = ? AND type = 'git_blob' ORDER BY rowid DESC LIMIT 1").get(contentHash) as { text?: string } | undefined;
    return row?.text;
  }

  recordLlmRun(provider: string, model: string, status: string, usage: LlmUsage, result: unknown) {
    const id = crypto.randomUUID(), now = new Date().toISOString();
    this.#db.prepare("INSERT INTO llm_runs(id, audit_id, provider, model, status, usage_json, result_json) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, this.auditId, provider, model, status, JSON.stringify(usage), JSON.stringify(result));
    this.#db.prepare("INSERT INTO budget_transactions(id, audit_id, kind, amount_usd, input_tokens, output_tokens, metadata_json, created_at) VALUES (?, ?, 'settlement', ?, ?, ?, ?, ?)").run(crypto.randomUUID(), this.auditId, usage.actualCostUsd ?? usage.estimatedCostUsd, usage.inputTokens, usage.outputTokens, JSON.stringify({ provider, model, llmRunId: id }), now);
  }

  #recordFinding(finding: Finding, insertFinding: ReturnType<DatabaseSync["prepare"]>, insertEvidence: ReturnType<DatabaseSync["prepare"]>) {
    const findingId = `${this.auditId}:${finding.id}`;
    insertFinding.run(findingId, this.auditId, `${this.auditId}:${finding.artifact.id}`, finding.layer, finding.category, finding.severity, finding.confidence, finding.summary, finding.evidenceSpan);
    finding.matches.forEach((match, index) => insertEvidence.run(findingId, index, match.kind, match.value, match.start, match.end, match.confidence));
  }

  close() { this.#db.close(); }
}

function encodeVector(vector: number[]) { return Buffer.from(new Float32Array(vector).buffer); }
function decodeVector(value: Uint8Array) {
  const buffer = Buffer.from(value);
  const result: number[] = [];
  for (let offset = 0; offset + 4 <= buffer.length; offset += 4) result.push(buffer.readFloatLE(offset));
  return result;
}
function cosineSimilarity(left: number[], right: number[]) {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index++) { dot += left[index] * right[index]; leftNorm += left[index] ** 2; rightNorm += right[index] ** 2; }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
