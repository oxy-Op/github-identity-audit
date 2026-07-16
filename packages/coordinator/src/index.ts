import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { generateAliases } from "../../core/src/aliases.ts";
import { matchArtifact } from "../../core/src/matcher.ts";
import type { AuditReport, Finding, IdentityProfile, ScanLimits, ScanWarning } from "../../core/src/types.ts";
import { GitHubClient, usernameFromGitHubUrl } from "../../github-client/src/index.ts";
import { prepareRepository, scanGitRepository } from "../../git-scanner/src/index.ts";
import { AuditDatabase } from "../../database/src/index.ts";
import { rankFindings, retrieveSemanticFindings, type EmbeddingProvider, type SemanticRetrievalOptions } from "../../retrieval/src/index.ts";
import { BudgetExceededError, BudgetLedger, DEFAULT_AUDIT_BUDGET, type AuditBudget } from "../../budget/src/index.ts";
import { CodexCliProvider, OpenRouterProvider, type ClassifyOptions, type LlmProvider } from "../../llm/src/index.ts";
import type { CompositeBinaryExtractor } from "../../extractors/src/index.ts";

export interface AccountAuditOptions {
  account: string;
  names: string[];
  emails: string[];
  output: string;
  token?: string;
  includeForks: boolean;
  includeArchived: boolean;
  maxRepositories: number;
  maxRepositorySizeKiB: number;
  maxSocialItems: number;
  maxDeepSocialItems?: number;
  contributionYears?: number;
  limits: ScanLimits;
  onProgress?: (message: string) => void;
  llm?: { provider: "openrouter" | "codex"; apiKey?: string; schemaPath?: string; options: ClassifyOptions; budget?: AuditBudget; batchSize?: number; };
  semantic?: { provider: EmbeddingProvider; options?: Partial<SemanticRetrievalOptions>; };
  binaryExtractor?: Pick<CompositeBinaryExtractor, "extract">;
  deleteMirrorsAfterScan?: boolean;
}

export async function auditGitHubAccount(options: AccountAuditOptions): Promise<AuditReport> {
  const username = usernameFromGitHubUrl(options.account);
  const discovery = await new GitHubClient({ token: options.token }).discoverAccount(username);
  const profile: IdentityProfile = { githubUsername: username, githubDatabaseId: discovery.profile.id, githubNodeId: discovery.profile.nodeId, names: options.names, emails: options.emails };
  const aliases = generateAliases(profile);
  const database = await AuditDatabase.create(join(options.output, "audit.sqlite"), options.account, profile, aliases);
  const warnings: ScanWarning[] = [];
  let repositories = discovery.repositories.filter((repo) => !repo.disabled);
  if (!options.includeForks) repositories = repositories.filter((repo) => !repo.fork);
  if (!options.includeArchived) repositories = repositories.filter((repo) => !repo.archived);
  const oversized = repositories.filter((repo) => repo.sizeKiB > options.maxRepositorySizeKiB);
  repositories = repositories.filter((repo) => repo.sizeKiB <= options.maxRepositorySizeKiB);
  if (oversized.length) warnings.push({ code: "REPOSITORY_SIZE_LIMIT", message: `${oversized.length} repositories exceeded ${options.maxRepositorySizeKiB} KiB and were skipped.`, count: oversized.length });
  if (repositories.length > options.maxRepositories) {
    warnings.push({ code: "REPOSITORY_COUNT_LIMIT", message: `${repositories.length - options.maxRepositories} repositories were skipped by the repository-count limit.`, count: repositories.length - options.maxRepositories });
    repositories = repositories.slice(0, options.maxRepositories);
  }
  for (const repository of repositories) database.recordRepository(repository);

  const findings: Finding[] = [];
  const semanticArtifacts = [];
  const metrics: Record<string, number> = { repositoriesDiscovered: discovery.repositories.length, repositoriesSelected: repositories.length, repositoriesScanned: 0, repositoriesFailed: 0, commitsScanned: 0, tagsScanned: 0, historicalPathsScanned: 0, uniqueBlobsScanned: 0, textBytesScanned: 0, artifactsScanned: 0, commitTreesEnumerated: 0, blobsSkippedFiltered: 0, blobsLoadedFromCache: 0, blobsSkippedLarge: 0, blobsSkippedBudget: 0, binariesExtracted: 0, binariesSkipped: 0 };
  try {
    const socialClient = new GitHubClient({ token: options.token, maxRequests: options.token ? 500 : 20 });
    const social = await socialClient.discoverSocialItems(username, options.maxSocialItems);
    const maxDeepSocialItems = options.maxDeepSocialItems ?? 0;
    if (options.token && maxDeepSocialItems > 0) {
      social.push(...await socialClient.discoverHistoricalContributions(username, options.contributionYears ?? 10, maxDeepSocialItems));
      if (social.length < maxDeepSocialItems) social.push(...await socialClient.discoverRepositorySocialItems(username, repositories, maxDeepSocialItems - social.length));
      if (social.length < maxDeepSocialItems) social.push(...await socialClient.discoverRepositoryDiscussions(username, repositories, maxDeepSocialItems - social.length));
    }
    else warnings.push({ code: "AUTHENTICATED_SOCIAL_SURFACES_SKIPPED", message: "Repository comments, reviews, commit comments, releases, discussions, and exhaustive historical contributions require authenticated deep-social discovery." });
    const socialArtifacts = social.map((item) => ({ id: item.id, type: item.type, text: item.text, contentHash: createHash("sha256").update(item.text).digest("hex"), repository: item.repository ?? username, provenance: { ...item.provenance, url: item.url, authoredAt: item.authoredAt } }));
    database.recordArtifacts(socialArtifacts);
    database.recordExtractionSignals(socialArtifacts, profile);
    semanticArtifacts.push(...socialArtifacts);
    findings.push(...socialArtifacts.flatMap((artifact) => matchArtifact(artifact, profile, aliases)));
    metrics.socialArtifactsScanned = socialArtifacts.length;
    metrics.artifactsScanned += socialArtifacts.length;
  } catch (error) {
    warnings.push({ code: "SOCIAL_DISCOVERY_FAILED", message: error instanceof Error ? error.message : String(error) });
  }
  for (const [index, repository] of repositories.entries()) {
    options.onProgress?.(`[${index + 1}/${repositories.length}] ${repository.fullName}`);
    try {
      const mirror = await prepareRepository(repository.cloneUrl, join(options.output, "mirrors"));
      const scan = await scanGitRepository(mirror, options.limits, { getText: (contentHash) => database.getCachedArtifactText(contentHash) }, { binaryExtractor: options.binaryExtractor });
      database.recordArtifacts(scan.artifacts);
      database.recordExtractionSignals(scan.artifacts, profile);
      semanticArtifacts.push(...scan.artifacts);
      findings.push(...scan.artifacts.flatMap((artifact) => matchArtifact(artifact, profile, aliases)));
      metrics.repositoriesScanned++;
      metrics.commitsScanned += scan.metrics.commitsScanned;
      metrics.tagsScanned += scan.metrics.tagsScanned ?? 0;
      metrics.historicalPathsScanned += scan.metrics.historicalPathsScanned ?? 0;
      metrics.uniqueBlobsScanned += scan.metrics.uniqueBlobsScanned;
      metrics.textBytesScanned += scan.metrics.textBytesScanned;
      metrics.artifactsScanned += scan.artifacts.length;
      metrics.commitTreesEnumerated += scan.metrics.commitTreesEnumerated ?? 0;
      metrics.blobsSkippedFiltered += scan.metrics.blobsSkippedFiltered ?? 0;
      metrics.blobsLoadedFromCache += scan.metrics.blobsLoadedFromCache ?? 0;
      metrics.blobsSkippedLarge += scan.metrics.blobsSkippedLarge ?? 0;
      metrics.blobsSkippedBudget += scan.metrics.blobsSkippedBudget ?? 0;
      metrics.binariesExtracted += scan.metrics.binariesExtracted ?? 0;
      metrics.binariesSkipped += scan.metrics.binariesSkipped ?? 0;
      database.setRepositoryStatus(repository.id, "scanned");
      warnings.push(...scan.warnings.map((warning) => ({ ...warning, message: `${repository.fullName}: ${warning.message}` })));
      if (options.deleteMirrorsAfterScan) {
        try {
          const root = resolve(options.output, "mirrors"), target = resolve(mirror);
          if (!target.startsWith(`${root}${sep}`)) throw new Error(`Refusing to delete mirror outside ${root}`);
          await rm(target, { recursive: true, force: true });
        } catch (error) { warnings.push({ code: "MIRROR_CLEANUP_FAILED", message: `${repository.fullName}: ${error instanceof Error ? error.message : String(error)}` }); }
      }
    } catch (error) {
      metrics.repositoriesFailed++;
      database.setRepositoryStatus(repository.id, "failed");
      warnings.push({ code: "REPOSITORY_SCAN_FAILED", message: `${repository.fullName}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (options.semantic) {
    const semanticFindings = await retrieveSemanticFindings(semanticArtifacts, options.semantic.provider, {
      queries: options.semantic.options?.queries ?? ["personal name or identity disclosure", "employment organization and workplace", "personal location biography or contact information", "authorship ownership and creator attribution"],
      maxChunks: options.semantic.options?.maxChunks ?? 5_000,
      maxCandidates: options.semantic.options?.maxCandidates ?? 200,
      threshold: options.semantic.options?.threshold ?? 0.62,
      batchSize: options.semantic.options?.batchSize ?? 32,
      onEmbeddedBatch: async (records) => {
        database.recordChunkEmbeddings(records, options.semantic!.provider.name, options.semantic!.provider.model ?? options.semantic!.provider.name);
        metrics.chunksEmbedded = (metrics.chunksEmbedded ?? 0) + records.length;
        await options.semantic?.options?.onEmbeddedBatch?.(records);
      },
      hybridSearch: async (queries) => {
        const provider = options.semantic!.provider;
        const persisted = queries.flatMap(({ query, vector }) => database.searchHybrid(query, vector, provider.name, provider.model ?? provider.name, options.semantic!.options?.maxCandidates ?? 200).map(({ artifactId, score }) => ({ artifactId, score })));
        const external = await options.semantic?.options?.hybridSearch?.(queries) ?? [];
        return [...persisted, ...external];
      }
    });
    findings.push(...semanticFindings);
    metrics.semanticCandidates = semanticFindings.length;
  }
  const rankedFindings = rankFindings(findings);
  if (options.llm) await adjudicateAmbiguous(rankedFindings, aliases.map((alias) => alias.value), username, options.llm, warnings, metrics, database, options.onProgress);
  if (rankedFindings.length > options.limits.maxFindings) warnings.push({ code: "FINDING_LIMIT", message: `Only the top ${options.limits.maxFindings} of ${rankedFindings.length} findings are included.`, count: rankedFindings.length - options.limits.maxFindings });
  metrics.findingsGenerated = rankedFindings.length;
  const report: AuditReport = { schemaVersion: "0.1", generatedAt: new Date().toISOString(), target: profile, aliases, source: discovery.profile.htmlUrl, complete: warnings.length === 0, metrics, warnings, findings: rankedFindings.slice(0, options.limits.maxFindings) };
  database.finish(report);
  database.close();
  return report;
}

async function adjudicateAmbiguous(findings: Finding[], aliases: string[], username: string, configuration: NonNullable<AccountAuditOptions["llm"]>, warnings: ScanWarning[], metrics: Record<string, number>, database: AuditDatabase, progress?: (message: string) => void) {
  let provider: LlmProvider;
  if (configuration.provider === "openrouter") {
    if (!configuration.apiKey) throw new Error("OpenRouter provider requires an API key");
    provider = new OpenRouterProvider(configuration.apiKey);
  } else {
    if (!configuration.schemaPath) throw new Error("Codex provider requires a finding schema path");
    provider = new CodexCliProvider(configuration.schemaPath);
  }
  const ledger = new BudgetLedger(configuration.budget ?? DEFAULT_AUDIT_BUDGET);
  const candidates = findings.filter((finding) => finding.category === "semantic_identity" || finding.confidence >= 0.4 && finding.confidence < 0.8 && finding.category !== "email");
  const batchSize = Math.max(1, Math.min(30, configuration.batchSize ?? 15));
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  let analyzed = 0;
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    progress?.(`LLM adjudication ${offset + 1}-${offset + batch.length} of ${candidates.length}`);
    try {
      const result = await provider.classify(batch.map((finding) => ({ id: finding.id, finding })), { githubUsername: username, knownAliases: aliases }, ledger, configuration.options);
      database.recordLlmRun(provider.name, configuration.options.model, "completed", result.usage, result.findings);
      analyzed += batch.length;
      for (const classified of result.findings) {
        const finding = byId.get(classified.candidateId);
        if (finding) finding.adjudication = { provider: provider.name, relationship: classified.relationship, subjectIsTarget: classified.subjectIsTarget, confidence: classified.confidence, explanation: classified.explanation };
      }
    } catch (error) {
      if (error instanceof BudgetExceededError) { warnings.push({ code: "LLM_BUDGET_EXHAUSTED", message: `LLM budget exhausted after ${analyzed} of ${candidates.length} ambiguous candidates.` }); break; }
      warnings.push({ code: "LLM_BATCH_FAILED", message: `LLM adjudication stopped: ${error instanceof Error ? error.message : String(error)}` });
      break;
    }
  }
  const usage = ledger.snapshot();
  metrics.llmCandidatesAnalyzed = analyzed;
  metrics.llmCalls = usage.calls;
  metrics.llmInputTokens = usage.inputTokens;
  metrics.llmOutputTokens = usage.outputTokens;
  metrics.llmCostMicrousd = Math.round(usage.costUsd * 1_000_000);
}
