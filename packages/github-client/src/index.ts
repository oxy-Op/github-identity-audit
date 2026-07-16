export interface GitHubProfile {
  login: string;
  id: number;
  nodeId: string;
  name: string | null;
  bio: string | null;
  blog: string | null;
  company: string | null;
  location: string | null;
  htmlUrl: string;
  publicRepos: number;
}

export interface GitHubRepository {
  id: number;
  nodeId: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  fork: boolean;
  archived: boolean;
  disabled: boolean;
  sizeKiB: number;
  description: string | null;
  topics: string[];
}

export interface RateLimitSnapshot { limit?: number; remaining?: number; resetAt?: string; }
export interface GitHubDiscovery { profile: GitHubProfile; repositories: GitHubRepository[]; rateLimit: RateLimitSnapshot; }
export interface GitHubSocialItem { id: string; type: "issue" | "issue_comment" | "pull_request" | "review" | "review_comment" | "discussion" | "commit_comment" | "release" | "gist" | "profile"; text: string; url: string; repository?: string; authoredAt?: string; provenance: Record<string, unknown>; }
export interface GitHubClientOptions { token?: string; apiBaseUrl?: string; userAgent?: string; maxRequests?: number; fetch?: typeof fetch; }

export class GitHubClient {
  readonly #token?: string;
  readonly #apiBaseUrl: string;
  readonly #userAgent: string;
  readonly #maxRequests: number;
  readonly #fetch: typeof fetch;
  #requests = 0;
  #rateLimit: RateLimitSnapshot = {};

  constructor(options: GitHubClientOptions = {}) {
    this.#token = options.token;
    this.#apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.#userAgent = options.userAgent ?? "github-identity-audit/0.2";
    this.#maxRequests = options.maxRequests ?? 20;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get rateLimit() { return { ...this.#rateLimit }; }

  async discoverAccount(username: string): Promise<GitHubDiscovery> {
    const rawProfile = await this.#get<Record<string, unknown>>(`/users/${encodeURIComponent(username)}`);
    const repositories: GitHubRepository[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.#get<Record<string, unknown>[]>(`/users/${encodeURIComponent(username)}/repos?per_page=100&type=owner&sort=full_name&page=${page}`);
      repositories.push(...batch.map(mapRepository));
      if (batch.length < 100) break;
    }
    return { profile: mapProfile(rawProfile), repositories, rateLimit: this.rateLimit };
  }

  async discoverSocialItems(username: string, maxItems = 300): Promise<GitHubSocialItem[]> {
    const items: GitHubSocialItem[] = [];
    const profile = await this.#get<Record<string, unknown>>(`/users/${encodeURIComponent(username)}`);
    items.push({ id: `profile:${String(profile.id)}`, type: "profile", text: [profile.name, profile.bio, profile.company, profile.location, profile.blog].filter((value) => typeof value === "string" && value).join("\n"), url: String(profile.html_url ?? ""), provenance: profile });
    for (const searchType of ["issue", "pull-request"] as const) {
      for (let page = 1; items.length < maxItems; page++) {
        const result = await this.#get<{ items?: Record<string, unknown>[] }>(`/search/issues?q=author%3A${encodeURIComponent(username)}+is%3A${searchType}&sort=created&order=desc&per_page=100&page=${page}`);
        const batch = result.items ?? [];
        for (const item of batch) {
          const type = searchType === "pull-request" ? "pull_request" : "issue";
          items.push({ id: `${type}:${String(item.id)}`, type, text: `${String(item.title ?? "")}\n\n${String(item.body ?? "")}`, url: String(item.html_url ?? ""), repository: repositoryFromApiUrl(String(item.repository_url ?? "")), authoredAt: typeof item.created_at === "string" ? item.created_at : undefined, provenance: { id: item.id, number: item.number, state: item.state, labels: item.labels } });
          if (items.length >= maxItems) break;
        }
        if (batch.length < 100) break;
      }
    }
    if (items.length < maxItems) {
      const gists = await this.#get<Record<string, unknown>[]>(`/users/${encodeURIComponent(username)}/gists?per_page=${Math.min(100, maxItems - items.length)}`);
      for (const gist of gists) {
        const files = gist.files && typeof gist.files === "object" ? Object.keys(gist.files as object).join("\n") : "";
        items.push({ id: `gist:${String(gist.id)}`, type: "gist", text: `${String(gist.description ?? "")}\n${files}`, url: String(gist.html_url ?? ""), authoredAt: typeof gist.created_at === "string" ? gist.created_at : undefined, provenance: { id: gist.id, files: gist.files, public: gist.public } });
        if (items.length >= maxItems) break;
      }
    }
    return items;
  }

  async discoverRepositorySocialItems(username: string, repositories: GitHubRepository[], maxItems = 1_000): Promise<GitHubSocialItem[]> {
    const items: GitHubSocialItem[] = [];
    const normalizedLogin = username.toLowerCase();
    for (const repository of repositories) {
      const endpoints: Array<{ path: string; type: GitHubSocialItem["type"] }> = [
        { path: "issues/comments", type: "issue_comment" },
        { path: "pulls/comments", type: "review_comment" },
        { path: "comments", type: "commit_comment" },
        { path: "releases", type: "release" }
      ];
      for (const endpoint of endpoints) {
        const records = await this.#get<Record<string, unknown>[]>(`/repos/${repository.fullName}/${endpoint.path}?per_page=100`);
        for (const record of records) {
          const author = (record.user ?? record.author) as Record<string, unknown> | undefined;
          if (String(author?.login ?? "").toLowerCase() !== normalizedLogin) continue;
          const text = endpoint.type === "release" ? `${String(record.name ?? "")}\n${String(record.body ?? "")}` : String(record.body ?? "");
          items.push({ id: `${endpoint.type}:${String(record.id)}`, type: endpoint.type, text, url: String(record.html_url ?? ""), repository: repository.fullName, authoredAt: typeof record.created_at === "string" ? record.created_at : undefined, provenance: { id: record.id, apiUrl: record.url, commitId: record.commit_id, tagName: record.tag_name } });
          if (items.length >= maxItems) return items;
        }
      }
    }
    return items;
  }

  async discoverHistoricalContributions(username: string, years = 10, maxItems = 1_000): Promise<GitHubSocialItem[]> {
    if (!this.#token) throw new Error("Historical GraphQL contributions require a GitHub token");
    const items: GitHubSocialItem[] = [], now = new Date();
    for (let yearOffset = 0; yearOffset < years && items.length < maxItems; yearOffset++) {
      const to = new Date(Date.UTC(now.getUTCFullYear() - yearOffset + 1, 0, 1));
      const from = new Date(Date.UTC(now.getUTCFullYear() - yearOffset, 0, 1));
      if (yearOffset === 0) to.setTime(now.getTime());
      const data = await this.#graphql<any>(CONTRIBUTIONS_QUERY, { login: username, from: from.toISOString(), to: to.toISOString() });
      const collection = data.user?.contributionsCollection;
      for (const node of collection?.issueContributions?.nodes ?? []) items.push(graphqlItem("issue", node.issue));
      for (const node of collection?.pullRequestContributions?.nodes ?? []) items.push(graphqlItem("pull_request", node.pullRequest));
      for (const node of collection?.pullRequestReviewContributions?.nodes ?? []) items.push(graphqlReview(node.pullRequestReview));
      if (items.length >= maxItems) break;
    }
    return items.slice(0, maxItems);
  }

  async discoverRepositoryDiscussions(username: string, repositories: GitHubRepository[], maxItems = 1_000): Promise<GitHubSocialItem[]> {
    if (!this.#token) throw new Error("Discussion discovery requires a GitHub token");
    const items: GitHubSocialItem[] = [], normalizedLogin = username.toLowerCase();
    for (const repository of repositories) {
      const [owner, name] = repository.fullName.split("/");
      if (!owner || !name) continue;
      let cursor: string | null = null;
      do {
        const data: any = await this.#graphql(DISCUSSIONS_QUERY, { owner, name, cursor });
        const connection = data.repository?.discussions;
        for (const discussion of connection?.nodes ?? []) {
          if (String(discussion.author?.login ?? "").toLowerCase() !== normalizedLogin) continue;
          items.push(graphqlItem("discussion", { ...discussion, repository: { nameWithOwner: repository.fullName } }));
          if (items.length >= maxItems) return items;
        }
        cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
      } while (cursor && items.length < maxItems);
    }
    return items;
  }

  async #get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": this.#userAgent, "X-GitHub-Api-Version": "2022-11-28" };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (++this.#requests > this.#maxRequests) throw new Error(`GitHub request budget exhausted (${this.#maxRequests})`);
      const response = await this.#fetch(`${this.#apiBaseUrl}${path}`, { headers, signal: AbortSignal.timeout(30_000) });
      this.#rateLimit = { limit: parseNumber(response.headers.get("x-ratelimit-limit")), remaining: parseNumber(response.headers.get("x-ratelimit-remaining")), resetAt: parseTimestamp(response.headers.get("x-ratelimit-reset")) };
      if (response.ok) return await response.json() as T;
      const retryAfter = Number(response.headers.get("retry-after") ?? 0) * 1000;
      const resetDelay = this.#rateLimit.remaining === 0 && this.#rateLimit.resetAt ? Math.max(0, Date.parse(this.#rateLimit.resetAt) - Date.now()) : 0;
      const retryDelay = retryAfter || resetDelay || (response.status >= 500 ? 500 * 2 ** attempt : 0);
      const detail = (await response.text()).slice(0, 500);
      if (attempt < 2 && retryDelay > 0 && retryDelay <= 60_000) { await new Promise((resolve) => setTimeout(resolve, retryDelay)); continue; }
      throw new Error(`GitHub API ${response.status} for ${path}: ${detail}${retryDelay > 60_000 ? ` (retry after ${Math.ceil(retryDelay / 1000)}s)` : ""}`);
    }
    throw new Error(`GitHub API retry budget exhausted for ${path}`);
  }

  async #graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (++this.#requests > this.#maxRequests) throw new Error(`GitHub request budget exhausted (${this.#maxRequests})`);
    const response = await this.#fetch(`${this.#apiBaseUrl}/graphql`, { method: "POST", headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json", "User-Agent": this.#userAgent }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GitHub GraphQL ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const result = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
    if (result.errors?.length) throw new Error(`GitHub GraphQL: ${result.errors.map((error) => error.message).join("; ")}`);
    if (!result.data) throw new Error("GitHub GraphQL returned no data");
    return result.data;
  }
}

export function usernameFromGitHubUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value.replace(/^@/, "").trim();
  const url = new URL(value);
  if (url.hostname.toLowerCase() !== "github.com") throw new Error("Account URL must use github.com");
  const username = url.pathname.split("/").filter(Boolean)[0];
  if (!username) throw new Error("GitHub account URL does not contain a username");
  return username;
}

const text = (value: unknown) => typeof value === "string" ? value : null;
const number = (value: unknown) => typeof value === "number" ? value : 0;
const parseNumber = (value: string | null) => value === null ? undefined : Number(value);
const parseTimestamp = (value: string | null) => value === null ? undefined : new Date(Number(value) * 1000).toISOString();

function mapProfile(raw: Record<string, unknown>): GitHubProfile {
  return { login: text(raw.login) ?? "", id: number(raw.id), nodeId: text(raw.node_id) ?? "", name: text(raw.name), bio: text(raw.bio), blog: text(raw.blog), company: text(raw.company), location: text(raw.location), htmlUrl: text(raw.html_url) ?? "", publicRepos: number(raw.public_repos) };
}

function mapRepository(raw: Record<string, unknown>): GitHubRepository {
  return { id: number(raw.id), nodeId: text(raw.node_id) ?? "", name: text(raw.name) ?? "", fullName: text(raw.full_name) ?? "", cloneUrl: text(raw.clone_url) ?? "", htmlUrl: text(raw.html_url) ?? "", defaultBranch: text(raw.default_branch) ?? "", fork: Boolean(raw.fork), archived: Boolean(raw.archived), disabled: Boolean(raw.disabled), sizeKiB: number(raw.size), description: text(raw.description), topics: Array.isArray(raw.topics) ? raw.topics.filter((item): item is string => typeof item === "string") : [] };
}

function repositoryFromApiUrl(value: string) {
  const match = value.match(/\/repos\/([^/]+\/[^/]+)$/);
  return match?.[1];
}

function graphqlItem(type: "issue" | "pull_request" | "discussion", item: any): GitHubSocialItem {
  return { id: `${type}:${String(item.databaseId ?? item.id)}`, type, text: `${String(item.title ?? "")}\n\n${String(item.body ?? "")}`, url: String(item.url ?? ""), repository: String(item.repository?.nameWithOwner ?? ""), authoredAt: item.createdAt, provenance: { nodeId: item.id, databaseId: item.databaseId } };
}
function graphqlReview(item: any): GitHubSocialItem {
  return { id: `review:${String(item.databaseId ?? item.id)}`, type: "review", text: String(item.body ?? ""), url: String(item.url ?? ""), repository: String(item.pullRequest?.repository?.nameWithOwner ?? ""), authoredAt: item.createdAt, provenance: { nodeId: item.id, databaseId: item.databaseId } };
}

const CONTRIBUTIONS_QUERY = `query($login:String!,$from:DateTime!,$to:DateTime!){user(login:$login){contributionsCollection(from:$from,to:$to){issueContributions(first:100){nodes{issue{id databaseId title body url createdAt repository{nameWithOwner}}}}pullRequestContributions(first:100){nodes{pullRequest{id databaseId title body url createdAt repository{nameWithOwner}}}}pullRequestReviewContributions(first:100){nodes{pullRequestReview{id databaseId body url createdAt pullRequest{repository{nameWithOwner}}}}}}}}`;
const DISCUSSIONS_QUERY = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){discussions(first:100,after:$cursor){nodes{id databaseId title body url createdAt author{login}}pageInfo{hasNextPage endCursor}}}}`;
