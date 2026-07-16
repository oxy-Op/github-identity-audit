import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { JobQueue, ObjectStore } from "../../runtime/src/index.ts";

export interface AuthenticatedUser { id: string; githubLogin: string; githubDatabaseId: number; }

export function enforceSelfAudit(user: AuthenticatedUser, requestedLogin: string) {
  if (user.githubLogin.toLowerCase() !== requestedLogin.toLowerCase()) throw new Error("Hosted mode only permits auditing the authenticated GitHub account");
}

export interface UserQuota { maxActiveAudits: number; maxAuditsPerDay: number; maxRepositoryBytesPerAudit: number; }

export class InMemoryQuotaStore {
  readonly #quota: UserQuota;
  readonly #active = new Map<string, number>();
  readonly #daily = new Map<string, { day: string; count: number }>();
  constructor(quota: UserQuota) { this.#quota = quota; }
  reserve(userId: string, estimatedRepositoryBytes: number) {
    if (estimatedRepositoryBytes > this.#quota.maxRepositoryBytesPerAudit) throw new Error("Repository-byte quota exceeded");
    const active = this.#active.get(userId) ?? 0;
    if (active >= this.#quota.maxActiveAudits) throw new Error("Active-audit quota exceeded");
    const day = new Date().toISOString().slice(0, 10), record = this.#daily.get(userId);
    const count = record?.day === day ? record.count : 0;
    if (count >= this.#quota.maxAuditsPerDay) throw new Error("Daily audit quota exceeded");
    this.#active.set(userId, active + 1); this.#daily.set(userId, { day, count: count + 1 });
    return () => this.#active.set(userId, Math.max(0, (this.#active.get(userId) ?? 1) - 1));
  }
}

export interface RemoteQueueClient { add(name: string, data: unknown, options?: Record<string, unknown>): Promise<{ id?: string | number }>; }
export class BullMqJobQueueAdapter {
  readonly #queue: RemoteQueueClient;
  constructor(queue: RemoteQueueClient) { this.#queue = queue; }
  async enqueueAudit(data: unknown) { return this.#queue.add("github-identity-audit", data, { removeOnComplete: 100, removeOnFail: 100 }); }
}

export interface S3CompatibleClient { putObject(input: { Bucket: string; Key: string; Body: Uint8Array }): Promise<unknown>; getObject(input: { Bucket: string; Key: string }): Promise<{ Body?: { transformToByteArray(): Promise<Uint8Array> } }>; }
export class S3ObjectStore implements ObjectStore {
  readonly #client: S3CompatibleClient; readonly #bucket: string; readonly #prefix: string;
  constructor(client: S3CompatibleClient, bucket: string, prefix = "") { this.#client = client; this.#bucket = bucket; this.#prefix = prefix; }
  async put(key: string, bytes: Uint8Array) { await this.#client.putObject({ Bucket: this.#bucket, Key: this.#prefix + key, Body: bytes }); }
  async get(key: string) { const result = await this.#client.getObject({ Bucket: this.#bucket, Key: this.#prefix + key }); return result.Body?.transformToByteArray(); }
}

export interface SqlClient { query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number }>; }
export class PostgresAuditLeaseStore {
  readonly #client: SqlClient;
  constructor(client: SqlClient) { this.#client = client; }
  async acquire(auditId: string, workerId: string, leaseSeconds = 300) {
    const result = await this.#client.query("UPDATE audits SET worker_id = $2, lease_expires_at = NOW() + ($3 * INTERVAL '1 second') WHERE id = $1 AND (lease_expires_at IS NULL OR lease_expires_at < NOW()) RETURNING id", [auditId, workerId, leaseSeconds]);
    return (result.rowCount ?? result.rows.length) === 1;
  }
}

export interface EncryptedSecret { version: 1; iv: string; tag: string; ciphertext: string; }
export function encryptSecret(value: string, key: Uint8Array): EncryptedSecret {
  if (key.byteLength !== 32) throw new Error("Secret encryption key must be 32 bytes");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv), encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64") };
}
export function decryptSecret(secret: EncryptedSecret, key: Uint8Array) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv, "base64")); decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

export function signUserSession(user: AuthenticatedUser, secret: string, ttlSeconds = 3_600) {
  if (secret.length < 32) throw new Error("Session secret must contain at least 32 characters");
  const payload = Buffer.from(JSON.stringify({ ...user, expiresAt: Date.now() + ttlSeconds * 1000 })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

export function verifyUserSession(token: string, secret: string): AuthenticatedUser | undefined {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return undefined;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
  const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthenticatedUser & { expiresAt: number };
  if (value.expiresAt <= Date.now()) return undefined;
  return { id: value.id, githubLogin: value.githubLogin, githubDatabaseId: value.githubDatabaseId };
}
