import test from "node:test";
import assert from "node:assert/strict";
import { BudgetExceededError, BudgetLedger, DEFAULT_AUDIT_BUDGET } from "./index.ts";

test("reservations prevent concurrent overspending", () => {
  const ledger = new BudgetLedger({ ...DEFAULT_AUDIT_BUDGET, maxTotalUsd: 1 });
  ledger.reserve({ candidates: 10, inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.6, expensive: false });
  assert.throws(() => ledger.reserve({ candidates: 10, inputTokens: 100, outputTokens: 10, estimatedCostUsd: 0.6, expensive: false }), BudgetExceededError);
});

test("settles reservations against actual usage", () => {
  const ledger = new BudgetLedger(DEFAULT_AUDIT_BUDGET);
  const reservation = ledger.reserve({ candidates: 2, inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.1, expensive: false });
  ledger.settle(reservation.id, { provider: "test", model: "test", inputTokens: 80, cachedInputTokens: 0, outputTokens: 12, estimatedCostUsd: 0.08, actualCostUsd: 0.07 });
  assert.deepEqual(ledger.snapshot(), { calls: 1, candidates: 2, inputTokens: 80, outputTokens: 12, costUsd: 0.07, expensiveCalls: 0, activeReservations: 0 });
});
