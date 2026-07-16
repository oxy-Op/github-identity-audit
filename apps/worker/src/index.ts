#!/usr/bin/env node
import { resolve } from "node:path";
import { auditGitHubAccount } from "../../../packages/coordinator/src/index.ts";
import { writeReports } from "../../../packages/report/src/index.ts";

interface WorkerJob { account: string; names?: string[]; emails?: string[]; output: string; includeForks?: boolean; includeArchived?: boolean; }

async function readStdin() { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks).toString("utf8"); }
function log(event: string, fields: Record<string, unknown> = {}) { process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "info", event, ...fields })}\n`); }

async function main() {
  const job = JSON.parse(await readStdin()) as WorkerJob;
  if (typeof job.account !== "string" || typeof job.output !== "string" || !Array.isArray(job.names ?? [])) throw new Error("Invalid worker job");
  const output = resolve(job.output);
  log("audit.started", { account: job.account, output });
  const report = await auditGitHubAccount({ account: job.account, names: job.names ?? [], emails: job.emails ?? [], output, token: process.env.GITHUB_TOKEN, includeForks: job.includeForks ?? false, includeArchived: job.includeArchived ?? true, maxRepositories: 100, maxRepositorySizeKiB: 256_000, maxSocialItems: 300, maxDeepSocialItems: 1_000, contributionYears: 10, limits: { maxBlobBytes: 5_000_000, maxTotalTextBytes: 100_000_000, maxFindings: 10_000, maxCommitTrees: 5_000 }, deleteMirrorsAfterScan: process.env.AUDIT_DELETE_MIRRORS === "true", onProgress: (stage) => log("audit.progress", { stage }) });
  await writeReports(report, output);
  log("audit.completed", { complete: report.complete, findings: report.findings.length, metrics: report.metrics, warnings: report.warnings.length });
  process.stdout.write(`${JSON.stringify({ output, complete: report.complete, findings: report.findings.length, metrics: report.metrics })}\n`);
}

main().catch((error) => { process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level: "error", event: "audit.failed", error: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; });
