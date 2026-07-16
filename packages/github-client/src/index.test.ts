import test from "node:test";
import assert from "node:assert/strict";
import { GitHubClient, usernameFromGitHubUrl } from "./index.ts";

test("extracts an account from a repository-tab URL", () => {
  assert.equal(usernameFromGitHubUrl("https://github.com/sasha-777?tab=repositories"), "sasha-777");
});

test("discovers profile and repositories with a bounded client", async () => {
  const responses = [
    { login: "sasha-777", id: 7, node_id: "U_7", html_url: "https://github.com/sasha-777", public_repos: 1 },
    [{ id: 8, node_id: "R_8", name: "demo", full_name: "sasha-777/demo", clone_url: "https://github.com/sasha-777/demo.git", html_url: "https://github.com/sasha-777/demo", default_branch: "main", size: 2, topics: [] }]
  ];
  const calls: string[] = [];
  const mockFetch = async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "58" } });
  };
  const result = await new GitHubClient({ fetch: mockFetch as typeof fetch, maxRequests: 2 }).discoverAccount("sasha-777");
  assert.equal(result.profile.nodeId, "U_7");
  assert.equal(result.repositories[0].fullName, "sasha-777/demo");
  assert.equal(result.rateLimit.remaining, 58);
  assert.equal(calls.length, 2);
});
