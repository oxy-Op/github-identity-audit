import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { BullMqJobQueueAdapter, decryptSecret, encryptSecret, enforceSelfAudit, InMemoryQuotaStore, PostgresAuditLeaseStore, S3ObjectStore, signUserSession, verifyUserSession } from "./index.ts";

test("hosted mode enforces self-audit identity", () => {
  const user = { id: "1", githubLogin: "sasha-777", githubDatabaseId: 7 };
  enforceSelfAudit(user, "SASHA-777");
  assert.throws(() => enforceSelfAudit(user, "someone-else"));
});

test("encrypts provider secrets with authenticated encryption", () => {
  const key = randomBytes(32), encrypted = encryptSecret("provider-key", key);
  assert.equal(decryptSecret(encrypted, key), "provider-key");
  assert.notEqual(encrypted.ciphertext, "provider-key");
});

test("applies active and daily user quotas", () => {
  const quotas = new InMemoryQuotaStore({ maxActiveAudits: 1, maxAuditsPerDay: 2, maxRepositoryBytesPerAudit: 100 });
  const release = quotas.reserve("user", 50);
  assert.throws(() => quotas.reserve("user", 50));
  release(); quotas.reserve("user", 50)();
  assert.throws(() => quotas.reserve("user", 50));
});

test("signs and verifies hosted user sessions", () => {
  const user = { id: "7", githubLogin: "sasha-777", githubDatabaseId: 7 }, secret = "a-secure-session-secret-with-32-characters";
  const token = signUserSession(user, secret);
  assert.deepEqual(verifyUserSession(token, secret), user);
  assert.equal(verifyUserSession(`${token}tampered`, secret), undefined);
});

test("BullMQ adapter enqueues a bounded-retention audit job", async () => {
  let request: unknown;
  const queue = new BullMqJobQueueAdapter({ add: async (...args) => { request = args; return { id: "job-1" }; } });
  assert.deepEqual(await queue.enqueueAudit({ auditId: "audit-1" }), { id: "job-1" });
  assert.deepEqual(request, ["github-identity-audit", { auditId: "audit-1" }, { removeOnComplete: 100, removeOnFail: 100 }]);
});

test("S3-compatible adapter round trips bytes through its client contract", async () => {
  const objects = new Map<string, Uint8Array>();
  const store = new S3ObjectStore({
    putObject: async ({ Bucket, Key, Body }) => { objects.set(`${Bucket}/${Key}`, Body); },
    getObject: async ({ Bucket, Key }) => ({ Body: { transformToByteArray: async () => objects.get(`${Bucket}/${Key}`)! } })
  }, "reports", "users/7/");
  await store.put("audit.json", Buffer.from("evidence"));
  assert.equal(Buffer.from((await store.get("audit.json"))!).toString(), "evidence");
});

test("PostgreSQL lease adapter uses an atomic expiration predicate", async () => {
  let query: { text: string; values?: unknown[] } | undefined;
  const leases = new PostgresAuditLeaseStore({ query: async (text, values) => { query = { text, values }; return { rows: [{ id: "audit-1" }], rowCount: 1 }; } });
  assert.equal(await leases.acquire("audit-1", "worker-2", 120), true);
  assert.match(query!.text, /lease_expires_at < NOW\(\)/);
  assert.deepEqual(query!.values, ["audit-1", "worker-2", 120]);
});
