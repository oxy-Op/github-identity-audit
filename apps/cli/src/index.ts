#!/usr/bin/env node
import { resolve, join } from "node:path";
import { generateAliases } from "../../../packages/core/src/aliases.ts";
import { matchArtifact } from "../../../packages/core/src/matcher.ts";
import type { AuditReport, IdentityProfile, ScanLimits } from "../../../packages/core/src/types.ts";
import { auditGitHubAccount } from "../../../packages/coordinator/src/index.ts";
import { prepareRepository, scanGitRepository } from "../../../packages/git-scanner/src/index.ts";
import { writeReports } from "../../../packages/report/src/index.ts";
import { OpenAiCompatibleEmbeddingProvider, rankFindings } from "../../../packages/retrieval/src/index.ts";

function parseArgs(argv: string[]) {
  const result = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    if (token === "--help") { result.set("help", ["true"]); continue; }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    const key = token.slice(2);
    result.set(key, [...(result.get(key) ?? []), value]);
    index++;
  }
  return result;
}

function usage() {
  console.log(`Usage:
  Account: npm run audit -- --account GITHUB_PROFILE_URL --name PRIOR_NAME [--output DIR]
  Repo:    npm run audit -- --repo PATH_OR_URL --username USER [--name NAME] [--email EMAIL]

Account limits: --max-repositories 100 --max-repository-kib 1000000
Credentials:    GITHUB_TOKEN, OPENROUTER_API_KEY, and EMBEDDING_API_KEY environment variables only`);
}

function positiveNumber(value: string | undefined, fallback: number, option: string) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${option} must be a positive integer`);
  return number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("help")) { usage(); return; }
  const account = args.get("account")?.[0];
  const source = args.get("repo")?.[0], username = args.get("username")?.[0];
  if (!account && (!source || !username)) { usage(); throw new Error("Provide --account, or both --repo and --username"); }
  const targetName = account ? new URL(account).pathname.split("/").filter(Boolean)[0] : username!;
  const output = resolve(args.get("output")?.[0] ?? `identity-audit-${targetName}`);
  const limits: ScanLimits = {
    maxBlobBytes: positiveNumber(args.get("max-blob-bytes")?.[0], 5_000_000, "--max-blob-bytes"),
    maxTotalTextBytes: positiveNumber(args.get("max-total-bytes")?.[0], 250_000_000, "--max-total-bytes"),
    maxFindings: positiveNumber(args.get("max-findings")?.[0], 10_000, "--max-findings")
    ,maxCommitTrees: positiveNumber(args.get("max-commit-trees")?.[0], 5_000, "--max-commit-trees")
  };
  if (account) {
    const report = await auditGitHubAccount({
      account,
      names: args.get("name") ?? [],
      emails: args.get("email") ?? [],
      output,
      token: process.env.GITHUB_TOKEN,
      includeForks: args.get("include-forks")?.[0] === "true",
      includeArchived: args.get("include-archived")?.[0] !== "false",
      maxRepositories: positiveNumber(args.get("max-repositories")?.[0], 100, "--max-repositories"),
      maxRepositorySizeKiB: positiveNumber(args.get("max-repository-kib")?.[0], 1_000_000, "--max-repository-kib"),
      maxSocialItems: positiveNumber(args.get("max-social-items")?.[0], 300, "--max-social-items"),
      maxDeepSocialItems: positiveNumber(args.get("max-deep-social-items")?.[0], 1_000, "--max-deep-social-items"),
      contributionYears: positiveNumber(args.get("contribution-years")?.[0], 10, "--contribution-years"),
      limits,
      onProgress: (message) => console.error(message)
      ,llm: createLlmConfig(args)
      ,semantic: createSemanticConfig(args)
      ,deleteMirrorsAfterScan: args.get("delete-mirrors")?.[0] === "true"
    });
    await writeReports(report, output);
    console.log(`Account audit complete: ${report.findings.length} findings across ${report.metrics.repositoriesScanned} repositories`);
    console.log(`JSON: ${join(output, "report.json")}`);
    console.log(`HTML: ${join(output, "report.html")}`);
    return;
  }
  const profile: IdentityProfile = { githubUsername: username!, names: args.get("name") ?? [], emails: args.get("email") ?? [] };
  const aliases = generateAliases(profile);
  console.error(`Scanning ${source} for ${aliases.length} aliases…`);
  const repositoryPath = await prepareRepository(source!, join(output, "mirrors"));
  const scan = await scanGitRepository(repositoryPath, limits);
  const findings = rankFindings(scan.artifacts.flatMap((artifact) => matchArtifact(artifact, profile, aliases)));
  if (findings.length > limits.maxFindings) scan.warnings.push({ code: "FINDING_LIMIT", message: `Only the top ${limits.maxFindings} findings are included.`, count: findings.length - limits.maxFindings });
  const report: AuditReport = {
    schemaVersion: "0.1", generatedAt: new Date().toISOString(), target: profile, aliases, source: source!,
    complete: scan.warnings.length === 0,
    metrics: { ...scan.metrics, artifactsScanned: scan.artifacts.length, findingsGenerated: findings.length },
    warnings: scan.warnings, findings: findings.slice(0, limits.maxFindings)
  };
  await writeReports(report, output);
  console.log(`Audit complete: ${report.findings.length} findings`);
  console.log(`JSON: ${join(output, "report.json")}`);
  console.log(`HTML: ${join(output, "report.html")}`);
}

function createLlmConfig(args: Map<string, string[]>) {
  const provider = args.get("llm")?.[0];
  if (!provider || provider === "none") return undefined;
  if (provider !== "openrouter" && provider !== "codex") throw new Error("--llm must be none, openrouter, or codex");
  return {
    provider,
    apiKey: process.env.OPENROUTER_API_KEY,
    schemaPath: resolve("schemas/finding.schema.json"),
    batchSize: positiveNumber(args.get("llm-batch-size")?.[0], 15, "--llm-batch-size"),
    options: {
      model: args.get("model")?.[0] ?? (provider === "codex" ? "subscription" : "openai/gpt-4.1-mini"),
      maxOutputTokens: positiveNumber(args.get("llm-max-output")?.[0], 1_500, "--llm-max-output"),
      estimatedInputCostPerMillion: Number(args.get("input-price")?.[0] ?? 2),
      estimatedOutputCostPerMillion: Number(args.get("output-price")?.[0] ?? 10)
    }
  } as const;
}

function createSemanticConfig(args: Map<string, string[]>) {
  const endpoint = args.get("embedding-endpoint")?.[0];
  if (!endpoint) return undefined;
  const apiKey = process.env.EMBEDDING_API_KEY;
  const model = args.get("embedding-model")?.[0];
  if (!apiKey || !model) throw new Error("Semantic retrieval requires EMBEDDING_API_KEY and --embedding-model");
  return { provider: new OpenAiCompatibleEmbeddingProvider({ endpoint, apiKey, model }), options: { maxChunks: positiveNumber(args.get("max-embedding-chunks")?.[0], 5_000, "--max-embedding-chunks"), maxCandidates: positiveNumber(args.get("max-semantic-candidates")?.[0], 200, "--max-semantic-candidates"), threshold: Number(args.get("semantic-threshold")?.[0] ?? 0.62) } };
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
