import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanGitRepository } from "./index.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) { await exec("git", args, { cwd, windowsHide: true }); }

test("scans annotated tags and historical filenames", async () => {
  const repository = await mkdtemp(join(tmpdir(), "identity-audit-git-"));
  await git(repository, "init");
  await git(repository, "config", "user.name", "Sasha");
  await git(repository, "config", "user.email", "sasha@example.test");
  await writeFile(join(repository, "Sasha-notes.txt"), "public project\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "initial");
  await git(repository, "tag", "-a", "identity", "-m", "Released by Sasha");
  const result = await scanGitRepository(repository, { maxBlobBytes: 1_000_000, maxTotalTextBytes: 10_000_000, maxFindings: 100 });
  assert.ok(result.artifacts.some((artifact) => artifact.type === "tag" && artifact.text.includes("Released by Sasha")));
  assert.ok(result.artifacts.some((artifact) => artifact.type === "tree" && artifact.text.includes("Sasha-notes.txt")));
});
