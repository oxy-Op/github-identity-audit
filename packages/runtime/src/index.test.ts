import test from "node:test";
import assert from "node:assert/strict";
import { InProcessJobQueue } from "./index.ts";

test("bounds concurrent audit jobs", async () => {
  const queue = new InProcessJobQueue(1); let active = 0, peak = 0;
  const task = () => queue.enqueue(async () => { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); active--; });
  await Promise.all([task(), task(), task()]);
  assert.equal(peak, 1);
  assert.equal(queue.pending, 0);
});
