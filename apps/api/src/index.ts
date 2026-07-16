import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { auditGitHubAccount } from "../../../packages/coordinator/src/index.ts";
import { writeReports } from "../../../packages/report/src/index.ts";
import type { AuditReport } from "../../../packages/core/src/types.ts";
import { InProcessJobQueue } from "../../../packages/runtime/src/index.ts";
import { usernameFromGitHubUrl } from "../../../packages/github-client/src/index.ts";
import { enforceSelfAudit, signUserSession, verifyUserSession, type AuthenticatedUser } from "../../../packages/hosted/src/index.ts";

interface Job { id: string; status: "queued" | "running" | "completed" | "failed"; progress: string; createdAt: string; output: string; report?: AuditReport; error?: string; }
const jobs = new Map<string, Job>();
const queue = new InProcessJobQueue(Number(process.env.AUDIT_CONCURRENCY ?? 1));
const webPath = resolve("apps/web/index.html");
const host = process.env.AUDIT_HOST ?? "127.0.0.1";
const port = Number(process.env.AUDIT_PORT ?? 4317);
const allowedLogin = process.env.AUDIT_ALLOWED_GITHUB_LOGIN;
const oauth = process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET && process.env.SESSION_SECRET ? { clientId: process.env.GITHUB_CLIENT_ID, clientSecret: process.env.GITHUB_CLIENT_SECRET, sessionSecret: process.env.SESSION_SECRET } : undefined;
if (host !== "127.0.0.1" && host !== "localhost" && !allowedLogin && !oauth) throw new Error("Non-local binding requires GitHub OAuth configuration or AUDIT_ALLOWED_GITHUB_LOGIN");

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
    if (request.method === "GET" && url.pathname === "/auth/github") return startGithubLogin(request, response);
    if (request.method === "GET" && url.pathname === "/auth/callback") return finishGithubLogin(request, response, url);
    if (request.method === "GET" && url.pathname === "/") return html(response, await readFile(webPath, "utf8"));
    if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true });
    if (request.method === "POST" && url.pathname === "/api/audits") return createAudit(request, response);
    const match = url.pathname.match(/^\/api\/audits\/([a-f0-9-]+)(?:\/(report))?$/);
    if (request.method === "GET" && match) {
      const job = jobs.get(match[1]);
      if (!job) return json(response, 404, { error: "Audit not found" });
      if (match[2]) return job.report ? json(response, 200, job.report) : json(response, 409, { error: "Report is not ready", status: job.status });
      return json(response, 200, { ...job, report: undefined });
    }
    json(response, 404, { error: "Not found" });
  } catch (error) { json(response, 500, { error: error instanceof Error ? error.message : String(error) }); }
});

async function createAudit(request: IncomingMessage, response: ServerResponse) {
  const body = await readJson(request, 64_000) as Record<string, unknown>;
  if (typeof body.account !== "string" || !body.account.startsWith("https://github.com/")) return json(response, 400, { error: "account must be a github.com profile URL" });
  const requestedLogin = usernameFromGitHubUrl(body.account);
  if (oauth) {
    const user = authenticatedUser(request);
    if (!user) return json(response, 401, { error: "GitHub login required", loginUrl: "/auth/github" });
    try { enforceSelfAudit(user, requestedLogin); } catch (error) { return json(response, 403, { error: error instanceof Error ? error.message : String(error) }); }
  }
  if (allowedLogin && requestedLogin.toLowerCase() !== allowedLogin.toLowerCase()) return json(response, 403, { error: "Hosted mode only permits auditing the authenticated GitHub account" });
  const names = Array.isArray(body.names) ? body.names.filter((item): item is string => typeof item === "string") : [];
  const emails = Array.isArray(body.emails) ? body.emails.filter((item): item is string => typeof item === "string") : [];
  const id = randomUUID(), output = resolve("outputs", "api", id);
  const job: Job = { id, status: "queued", progress: "Queued", createdAt: new Date().toISOString(), output };
  jobs.set(id, job);
  void queue.enqueue(() => runAudit(job, body.account as string, names, emails));
  json(response, 202, { id, status: job.status, statusUrl: `/api/audits/${id}` });
}

function startGithubLogin(request: IncomingMessage, response: ServerResponse) {
  if (!oauth) return json(response, 404, { error: "GitHub OAuth is not configured" });
  const state = randomUUID(), secure = host === "127.0.0.1" || host === "localhost" ? "" : "; Secure";
  response.writeHead(302, { location: `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(oauth.clientId)}&scope=read%3Auser&state=${encodeURIComponent(state)}`, "set-cookie": `oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${secure}` });
  response.end();
}

async function finishGithubLogin(request: IncomingMessage, response: ServerResponse, url: URL) {
  if (!oauth) return json(response, 404, { error: "GitHub OAuth is not configured" });
  const code = url.searchParams.get("code"), state = url.searchParams.get("state"), expectedState = cookies(request).oauth_state;
  if (!code || !state || state !== expectedState) return json(response, 400, { error: "Invalid OAuth state" });
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: oauth.clientId, client_secret: oauth.clientSecret, code }), signal: AbortSignal.timeout(30_000) });
  const token = await tokenResponse.json() as { access_token?: string; error_description?: string };
  if (!token.access_token) return json(response, 401, { error: token.error_description ?? "GitHub OAuth exchange failed" });
  const userResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token.access_token}`, "User-Agent": "github-identity-audit/1.0" }, signal: AbortSignal.timeout(30_000) });
  if (!userResponse.ok) return json(response, 401, { error: "Could not load the authenticated GitHub user" });
  const github = await userResponse.json() as { id: number; login: string };
  const user: AuthenticatedUser = { id: String(github.id), githubLogin: github.login, githubDatabaseId: github.id };
  const session = signUserSession(user, oauth.sessionSecret), secure = host === "127.0.0.1" || host === "localhost" ? "" : "; Secure";
  response.writeHead(302, { location: "/", "set-cookie": [`audit_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${secure}`, `oauth_state=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`] }); response.end();
}

function authenticatedUser(request: IncomingMessage) { const token = cookies(request).audit_session; return token && oauth ? verifyUserSession(token, oauth.sessionSecret) : undefined; }
function cookies(request: IncomingMessage) { return Object.fromEntries((request.headers.cookie ?? "").split(";").map((item) => item.trim().split("=")).filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)])); }

async function runAudit(job: Job, account: string, names: string[], emails: string[]) {
  job.status = "running";
  try {
    const report = await auditGitHubAccount({ account, names, emails, output: job.output, token: process.env.GITHUB_TOKEN, includeForks: false, includeArchived: true, maxRepositories: 100, maxRepositorySizeKiB: 256_000, maxSocialItems: 300, maxDeepSocialItems: 1_000, contributionYears: 10, limits: { maxBlobBytes: 5_000_000, maxTotalTextBytes: 100_000_000, maxFindings: 10_000, maxCommitTrees: 5_000 }, deleteMirrorsAfterScan: process.env.AUDIT_DELETE_MIRRORS === "true", onProgress: (message) => job.progress = message });
    await writeReports(report, job.output);
    job.report = report; job.status = "completed"; job.progress = "Completed";
  } catch (error) { job.status = "failed"; job.error = error instanceof Error ? error.message : String(error); job.progress = "Failed"; }
}

function json(response: ServerResponse, status: number, value: unknown) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
function html(response: ServerResponse, value: string) { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" }); response.end(value); }
async function readJson(request: IncomingMessage, maxBytes: number) { const chunks: Buffer[] = []; let bytes = 0; for await (const chunk of request) { bytes += chunk.length; if (bytes > maxBytes) throw new Error("Request body too large"); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }

server.listen(port, host, () => console.log(`Identity Audit UI: http://${host}:${port}`));
