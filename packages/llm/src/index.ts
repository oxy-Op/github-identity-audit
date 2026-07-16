import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../../core/src/types.ts";
import type { BudgetLedger, LlmUsage } from "../../budget/src/index.ts";

export interface LlmCandidate { id: string; finding: Finding; }
export interface ClassifiedFinding { candidateId: string; relationship: string; subjectIsTarget: boolean; confidence: number; severity: "low" | "medium" | "high"; explanation: string; evidenceSpan: string; }
export interface ClassificationResult { findings: ClassifiedFinding[]; usage: LlmUsage; }
export interface ClassifyContext { githubUsername: string; knownAliases: string[]; }
export interface ClassifyOptions { model: string; maxOutputTokens: number; estimatedInputCostPerMillion: number; estimatedOutputCostPerMillion: number; expensive?: boolean; }

export interface LlmProvider {
  readonly name: string;
  classify(candidates: LlmCandidate[], context: ClassifyContext, ledger: BudgetLedger, options: ClassifyOptions): Promise<ClassificationResult>;
}

function payload(candidates: LlmCandidate[], context: ClassifyContext) {
  return { target: { github_username: context.githubUsername, known_aliases: context.knownAliases }, candidates: candidates.map(({ id, finding }) => ({ id, artifact_type: finding.artifact.type, repository: finding.artifact.repository, path: finding.artifact.path, text: finding.evidenceSpan, deterministic_category: finding.category, deterministic_score: finding.score, matched_values: finding.matches.map((item) => item.value) })) };
}

function estimateTokens(value: unknown) { return Math.ceil(JSON.stringify(value).length / 4); }

export class NoLlmProvider implements LlmProvider {
  readonly name = "disabled";
  async classify(): Promise<ClassificationResult> { return { findings: [], usage: { provider: this.name, model: "none", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }; }
}

export class OpenRouterProvider implements LlmProvider {
  readonly name = "openrouter";
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  constructor(apiKey: string, fetchImplementation: typeof fetch = fetch) { this.#apiKey = apiKey; this.#fetch = fetchImplementation; }

  async classify(candidates: LlmCandidate[], context: ClassifyContext, ledger: BudgetLedger, options: ClassifyOptions): Promise<ClassificationResult> {
    const bodyPayload = payload(candidates, context);
    const inputTokens = estimateTokens(bodyPayload);
    const estimatedCostUsd = inputTokens / 1_000_000 * options.estimatedInputCostPerMillion + options.maxOutputTokens / 1_000_000 * options.estimatedOutputCostPerMillion;
    const reservation = ledger.reserve({ candidates: candidates.length, inputTokens, outputTokens: options.maxOutputTokens, estimatedCostUsd, expensive: options.expensive ?? false });
    try {
      const response = await this.#fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${this.#apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: options.model, max_tokens: options.maxOutputTokens, response_format: { type: "json_schema", json_schema: { name: "identity_findings", strict: true, schema: CLASSIFICATION_SCHEMA } }, messages: [{ role: "system", content: "Classify only whether each supplied passage links the target to the observed identity. Return evidence-grounded JSON and do not infer from unrelated knowledge." }, { role: "user", content: JSON.stringify(bodyPayload) }] }), signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`OpenRouter ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const raw = await response.json() as Record<string, any>;
      const parsed = JSON.parse(String(raw.choices?.[0]?.message?.content ?? "{}"));
      const usage: LlmUsage = { provider: this.name, model: options.model, inputTokens: Number(raw.usage?.prompt_tokens ?? inputTokens), cachedInputTokens: Number(raw.usage?.prompt_tokens_details?.cached_tokens ?? 0), outputTokens: Number(raw.usage?.completion_tokens ?? 0), reasoningTokens: Number(raw.usage?.completion_tokens_details?.reasoning_tokens ?? 0), actualCostUsd: typeof raw.usage?.cost === "number" ? raw.usage.cost : undefined, estimatedCostUsd };
      ledger.settle(reservation.id, usage);
      return { findings: validateFindings(parsed.findings), usage };
    } catch (error) { ledger.release(reservation.id); throw error; }
  }
}

export class CodexCliProvider implements LlmProvider {
  readonly name = "codex-cli";
  readonly #executable: string;
  readonly #schemaPath: string;
  constructor(schemaPath: string, executable = "codex") { this.#schemaPath = schemaPath; this.#executable = executable; }

  async classify(candidates: LlmCandidate[], context: ClassifyContext, ledger: BudgetLedger, options: ClassifyOptions): Promise<ClassificationResult> {
    const bodyPayload = payload(candidates, context);
    const inputTokens = estimateTokens(bodyPayload);
    const estimatedCostUsd = inputTokens / 1_000_000 * options.estimatedInputCostPerMillion + options.maxOutputTokens / 1_000_000 * options.estimatedOutputCostPerMillion;
    const reservation = ledger.reserve({ candidates: candidates.length, inputTokens, outputTokens: options.maxOutputTokens, estimatedCostUsd, expensive: options.expensive ?? false });
    const workspace = await mkdtemp(join(tmpdir(), "identity-audit-codex-"));
    const output = join(workspace, "result.json");
    try {
      const events = await runCodex(this.#executable, workspace, this.#schemaPath, output, JSON.stringify(bodyPayload));
      const parsed = JSON.parse(await readFile(output, "utf8"));
      const completed = events.findLast((event) => event.type === "turn.completed") as Record<string, any> | undefined;
      const tokens = completed?.usage ?? completed?.turn?.usage ?? {};
      const usage: LlmUsage = { provider: this.name, model: options.model, inputTokens: Number(tokens.input_tokens ?? inputTokens), cachedInputTokens: Number(tokens.cached_input_tokens ?? 0), outputTokens: Number(tokens.output_tokens ?? 0), reasoningTokens: Number(tokens.reasoning_tokens ?? 0), estimatedCostUsd };
      ledger.settle(reservation.id, usage);
      return { findings: validateFindings(parsed.findings), usage };
    } catch (error) { ledger.release(reservation.id); throw error; }
  }
}

async function runCodex(executable: string, cwd: string, schema: string, output: string, input: string): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["exec", "--ephemeral", "--sandbox", "read-only", "--ignore-user-config", "--json", "--output-schema", schema, "-o", output, "Classify the supplied GitHub identity-link candidates. Do not inspect files or use network access."], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))) : reject(new Error(`Codex CLI failed (${code}): ${stderr.slice(-1000)}`)));
    child.stdin.end(input);
  });
}

function validateFindings(value: unknown): ClassifiedFinding[] {
  if (!Array.isArray(value)) throw new Error("LLM response did not contain a findings array");
  return value.map((item: any) => {
    if (typeof item?.candidate_id !== "string" || typeof item?.confidence !== "number" || typeof item?.subject_is_target !== "boolean") throw new Error("LLM returned an invalid finding");
    return { candidateId: item.candidate_id, relationship: String(item.relationship), subjectIsTarget: item.subject_is_target, confidence: Math.max(0, Math.min(1, item.confidence)), severity: item.severity, explanation: String(item.explanation), evidenceSpan: String(item.evidence_span) };
  });
}

export const CLASSIFICATION_SCHEMA = { type: "object", additionalProperties: false, required: ["findings"], properties: { findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["candidate_id", "relationship", "subject_is_target", "confidence", "severity", "explanation", "evidence_span"], properties: { candidate_id: { type: "string" }, relationship: { type: "string" }, subject_is_target: { type: "boolean" }, confidence: { type: "number", minimum: 0, maximum: 1 }, severity: { type: "string", enum: ["low", "medium", "high"] }, explanation: { type: "string" }, evidence_span: { type: "string" } } } } } } as const;
