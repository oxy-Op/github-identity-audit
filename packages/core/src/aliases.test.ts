import test from "node:test";
import assert from "node:assert/strict";
import { generateAliases } from "./aliases.ts";

test("derives safe username variants and stem", () => {
  const aliases = generateAliases({ githubUsername: "sasha-777", names: [], emails: [] });
  assert.deepEqual(new Set(aliases.map((item) => item.normalized)), new Set(["sasha-777", "sasha", "sasha777", "sasha_777"]));
});
