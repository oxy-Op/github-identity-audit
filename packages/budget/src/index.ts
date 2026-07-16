import { randomUUID } from "node:crypto";

export interface AuditBudget {
  maxTotalUsd?: number;
  maxLlmCalls: number;
  maxCandidatesAnalyzed: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  perRequest: { maxInputTokens: number; maxOutputTokens: number };
  escalation: { enabled: boolean; maxExpensiveModelCalls: number };
}

export interface UsageReservation {
  id: string;
  candidates: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  expensive: boolean;
}

export interface LlmUsage {
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  actualCostUsd?: number;
  estimatedCostUsd: number;
}

export class BudgetExceededError extends Error { readonly name = "BudgetExceededError"; }

export class BudgetLedger {
  readonly #budget: AuditBudget;
  readonly #reservations = new Map<string, UsageReservation>();
  #calls = 0;
  #candidates = 0;
  #inputTokens = 0;
  #outputTokens = 0;
  #costUsd = 0;
  #expensiveCalls = 0;

  constructor(budget: AuditBudget) { this.#budget = structuredClone(budget); }

  reserve(request: Omit<UsageReservation, "id">): UsageReservation {
    if (request.inputTokens > this.#budget.perRequest.maxInputTokens || request.outputTokens > this.#budget.perRequest.maxOutputTokens) throw new BudgetExceededError("Per-request token limit exceeded");
    const pending = [...this.#reservations.values()];
    const sum = (key: "candidates" | "inputTokens" | "outputTokens" | "estimatedCostUsd") => pending.reduce((total, item) => total + item[key], 0);
    if (this.#calls + pending.length + 1 > this.#budget.maxLlmCalls) throw new BudgetExceededError("LLM call limit exhausted");
    if (this.#candidates + sum("candidates") + request.candidates > this.#budget.maxCandidatesAnalyzed) throw new BudgetExceededError("Candidate limit exhausted");
    if (this.#inputTokens + sum("inputTokens") + request.inputTokens > this.#budget.maxInputTokens) throw new BudgetExceededError("Input-token limit exhausted");
    if (this.#outputTokens + sum("outputTokens") + request.outputTokens > this.#budget.maxOutputTokens) throw new BudgetExceededError("Output-token limit exhausted");
    if (this.#budget.maxTotalUsd !== undefined && this.#costUsd + sum("estimatedCostUsd") + request.estimatedCostUsd > this.#budget.maxTotalUsd) throw new BudgetExceededError("Monetary limit exhausted");
    if (request.expensive && (!this.#budget.escalation.enabled || this.#expensiveCalls + pending.filter((item) => item.expensive).length + 1 > this.#budget.escalation.maxExpensiveModelCalls)) throw new BudgetExceededError("Expensive-model escalation limit exhausted");
    const reservation = { ...request, id: randomUUID() };
    this.#reservations.set(reservation.id, reservation);
    return reservation;
  }

  settle(reservationId: string, usage: LlmUsage) {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) throw new Error(`Unknown budget reservation: ${reservationId}`);
    this.#reservations.delete(reservationId);
    this.#calls++;
    this.#candidates += reservation.candidates;
    this.#inputTokens += usage.inputTokens;
    this.#outputTokens += usage.outputTokens;
    this.#costUsd += usage.actualCostUsd ?? usage.estimatedCostUsd;
    if (reservation.expensive) this.#expensiveCalls++;
  }

  release(reservationId: string) { this.#reservations.delete(reservationId); }

  snapshot() {
    return { calls: this.#calls, candidates: this.#candidates, inputTokens: this.#inputTokens, outputTokens: this.#outputTokens, costUsd: this.#costUsd, expensiveCalls: this.#expensiveCalls, activeReservations: this.#reservations.size };
  }
}

export const DEFAULT_AUDIT_BUDGET: AuditBudget = { maxTotalUsd: 2, maxLlmCalls: 30, maxCandidatesAnalyzed: 500, maxInputTokens: 300_000, maxOutputTokens: 30_000, perRequest: { maxInputTokens: 15_000, maxOutputTokens: 1_500 }, escalation: { enabled: true, maxExpensiveModelCalls: 3 } };
