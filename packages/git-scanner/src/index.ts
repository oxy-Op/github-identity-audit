import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Artifact, ScanLimits, ScanWarning } from "../../core/src/types.ts";
import type { CompositeBinaryExtractor } from "../../extractors/src/index.ts";

async function git(cwd: string | undefined, args: string[], input?: string): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolvePromise(Buffer.concat(stdout))
      : reject(new Error(`git ${args[0]} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`)));
    child.stdin.end(input);
  });
}

async function* gitBatchBlobs(cwd: string, oids: string[]): AsyncGenerator<{ oid: string; bytes: Buffer }> {
  if (!oids.length) return;
  const child = spawn("git", ["cat-file", "--batch"], { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "", buffer = Buffer.alloc(0), expected: { oid: string; size: number } | undefined;
  child.stderr.on("data", (chunk) => stderr += chunk);
  const completion = new Promise<number | null>((resolveCompletion, reject) => { child.on("error", reject); child.on("close", resolveCompletion); });
  child.stdin.end(`${oids.join("\n")}\n`);
  for await (const chunk of child.stdout) {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (!expected) {
        const newline = buffer.indexOf(10);
        if (newline < 0) break;
        const header = buffer.subarray(0, newline).toString("utf8"), parts = header.split(" ");
        buffer = buffer.subarray(newline + 1);
        if (parts[1] === "missing") throw new Error(`Git object missing during batch read: ${parts[0]}`);
        expected = { oid: parts[0], size: Number(parts[2]) };
      }
      if (buffer.length < expected.size + 1) break;
      const bytes = Buffer.from(buffer.subarray(0, expected.size));
      buffer = buffer.subarray(expected.size + 1);
      const oid = expected.oid; expected = undefined;
      yield { oid, bytes };
    }
  }
  const code = await completion;
  if (code !== 0) throw new Error(`git cat-file --batch failed (${code}): ${stderr.trim()}`);
}

export interface GitScanResult {
  artifacts: Artifact[];
  warnings: ScanWarning[];
  metrics: Record<string, number>;
  repository: string;
}
export interface GitScanCache { getText(contentHash: string): string | undefined; }
export interface GitScanOptions { binaryExtractor?: Pick<CompositeBinaryExtractor, "extract">; }

export async function prepareRepository(source: string, mirrorRoot: string): Promise<string> {
  if (!/^https?:\/\//i.test(source) && !/^git@/i.test(source)) return resolve(source);
  await mkdir(mirrorRoot, { recursive: true });
  const name = basename(source).replace(/\.git$/i, "") || createHash("sha1").update(source).digest("hex");
  const target = join(mirrorRoot, `${name}.git`);
  try { await git(target, ["remote", "update", "--prune"]); }
  catch { await git(undefined, ["clone", "--mirror", source, target]); }
  return target;
}

export async function scanGitRepository(repositoryPath: string, limits: ScanLimits, cache?: GitScanCache, options: GitScanOptions = {}): Promise<GitScanResult> {
  await git(repositoryPath, ["rev-parse", "--git-dir"]);
  const repository = basename(repositoryPath).replace(/\.git$/i, "");
  const artifacts: Artifact[] = [], warnings: ScanWarning[] = [];
  let textBytes = 0, skippedLarge = 0, skippedBudget = 0, skippedFiltered = 0, binariesExtracted = 0, binariesSkipped = 0;

  const format = "%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00%x1e";
  const rawCommits = (await git(repositoryPath, ["log", "--all", `--format=${format}`])).toString("utf8");
  for (const record of rawCommits.split("\x1e")) {
    const parts = record.replace(/^\s+/, "").split("\x00");
    if (parts.length < 6) continue;
    const [oid, authorName, authorEmail, committerName, committerEmail, message] = parts;
    const text = `Author: ${authorName} <${authorEmail}>\nCommitter: ${committerName} <${committerEmail}>\n\n${message}`;
    artifacts.push({ id: `commit:${oid}`, type: "commit", text, contentHash: createHash("sha256").update(text).digest("hex"), repository, commitOid: oid, provenance: { authorName, authorEmail, committerName, committerEmail } });
    textBytes += Buffer.byteLength(text);
  }

  const rawTags = (await git(repositoryPath, ["for-each-ref", "refs/tags", "--format=%(objectname)%00%(refname:short)%00%(taggername)%00%(taggeremail)%00%(contents)%00%1e"])).toString("utf8");
  for (const record of rawTags.split("\x1e")) {
    const [oid, tagName, taggerName, taggerEmail, message] = record.replace(/^\s+/, "").split("\x00");
    if (!oid || !tagName) continue;
    const text = `Tag: ${tagName}\nTagger: ${taggerName ?? ""} ${taggerEmail ?? ""}\n\n${message ?? ""}`;
    artifacts.push({ id: `tag:${oid}:${tagName}`, type: "tag", text, contentHash: createHash("sha256").update(text).digest("hex"), repository, provenance: { oid, tagName, taggerName, taggerEmail } });
    textBytes += Buffer.byteLength(text);
  }

  const objectLines = (await git(repositoryPath, ["rev-list", "--objects", "--all"])).toString("utf8").split(/\r?\n/).filter(Boolean);
  const paths = new Map<string, string>();
  for (const line of objectLines) {
    const space = line.indexOf(" ");
    paths.set(space < 0 ? line : line.slice(0, space), space < 0 ? "" : line.slice(space + 1));
  }
  const commitOids = artifacts.filter((artifact) => artifact.type === "commit").map((artifact) => artifact.commitOid!).filter(Boolean);
  const maxCommitTrees = limits.maxCommitTrees ?? 5_000;
  const occurrenceMap = new Map<string, Array<{ path: string; commitOid: string }>>();
  for (const commitOid of commitOids.slice(0, maxCommitTrees)) {
    const tree = (await git(repositoryPath, ["ls-tree", "-r", "--full-tree", commitOid])).toString("utf8");
    for (const line of tree.split(/\r?\n/)) {
      const match = line.match(/^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/);
      if (!match) continue;
      const occurrences = occurrenceMap.get(match[1]) ?? [];
      occurrences.push({ path: match[2], commitOid });
      occurrenceMap.set(match[1], occurrences);
    }
  }
  if (commitOids.length > maxCommitTrees) warnings.push({ code: "COMMIT_TREE_LIMIT", message: `${commitOids.length - maxCommitTrees} commit trees were not enumerated for artifact occurrences.`, count: commitOids.length - maxCommitTrees });
  const allHistoricalPaths = [...new Set([...occurrenceMap.values()].flat().map((occurrence) => occurrence.path))];
  const maxHistoricalPaths = limits.maxHistoricalPaths ?? 50_000;
  const retainedPaths = allHistoricalPaths.slice(0, maxHistoricalPaths);
  for (let offset = 0; offset < retainedPaths.length; offset += 500) {
    const text = retainedPaths.slice(offset, offset + 500).join("\n");
    artifacts.push({ id: `tree-paths:${offset / 500}`, type: "tree", text, contentHash: createHash("sha256").update(text).digest("hex"), repository, provenance: { historicalFilenameBatch: true, pathCount: Math.min(500, retainedPaths.length - offset) } });
    textBytes += Buffer.byteLength(text);
  }
  if (allHistoricalPaths.length > maxHistoricalPaths) warnings.push({ code: "HISTORICAL_PATH_LIMIT", message: `${allHistoricalPaths.length - maxHistoricalPaths} historical paths were not retained for matching.`, count: allHistoricalPaths.length - maxHistoricalPaths });
  const checks = (await git(repositoryPath, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], `${[...paths.keys()].join("\n")}\n`)).toString("utf8").split(/\r?\n/);
  const selectedBlobs: Array<{ oid: string; size: number }> = [];
  let reservedTextBytes = textBytes;
  for (const check of checks) {
    const [oid, type, sizeText] = check.split(" ");
    if (type !== "blob") continue;
    const occurrencePaths = (occurrenceMap.get(oid) ?? []).map((item) => item.path);
    const knownPaths = occurrencePaths.length ? occurrencePaths : [paths.get(oid) ?? ""];
    if (knownPaths.length > 0 && knownPaths.every(isLowValuePath)) { skippedFiltered++; continue; }
    const size = Number(sizeText);
    if (size > limits.maxBlobBytes) { skippedLarge++; continue; }
    if (reservedTextBytes + size > limits.maxTotalTextBytes) { skippedBudget++; continue; }
    reservedTextBytes += size;
    selectedBlobs.push({ oid, size });
  }
  const blobSizes = new Map(selectedBlobs.map((item) => [item.oid, item.size]));
  const uncachedBlobs: Array<{ oid: string; size: number }> = [];
  let cachedBlobs = 0;
  for (const blob of selectedBlobs) {
    const cachedText = cache?.getText(blob.oid);
    if (cachedText === undefined) { uncachedBlobs.push(blob); continue; }
    appendBlobArtifact(artifacts, repository, blob.oid, blob.size, cachedText, occurrenceMap, paths);
    textBytes += blob.size; cachedBlobs++;
  }
  for await (const { oid, bytes: buffer } of gitBatchBlobs(repositoryPath, uncachedBlobs.map((item) => item.oid))) {
    const size = blobSizes.get(oid) ?? buffer.length;
    const path = occurrenceMap.get(oid)?.[0]?.path ?? paths.get(oid) ?? "";
    if (buffer.includes(0) || /\.(pdf|png|jpe?g|gif|webp|tiff?)$/i.test(path)) {
      if (!options.binaryExtractor) { binariesSkipped++; continue; }
      const extracted = await options.binaryExtractor.extract({ path, bytes: buffer });
      if (extracted.status !== "extracted" || !extracted.text) { binariesSkipped++; continue; }
      appendBlobArtifact(artifacts, repository, oid, size, extracted.text, occurrenceMap, paths, { extractor: extracted.extractor, mediaType: extracted.mediaType });
      textBytes += Buffer.byteLength(extracted.text); binariesExtracted++;
      continue;
    }
    const text = buffer.toString("utf8");
    if ((text.match(/\uFFFD/g)?.length ?? 0) > Math.max(3, text.length / 100)) continue;
    appendBlobArtifact(artifacts, repository, oid, size, text, occurrenceMap, paths);
    textBytes += size;
  }
  if (skippedLarge) warnings.push({ code: "BLOB_SIZE_LIMIT", message: `${skippedLarge} blobs exceeded the per-blob byte limit.`, count: skippedLarge });
  if (skippedBudget) warnings.push({ code: "TOTAL_TEXT_LIMIT", message: `${skippedBudget} blobs were skipped after the total text budget was reached.`, count: skippedBudget });
  if (binariesSkipped) warnings.push({ code: options.binaryExtractor ? "BINARY_EXTRACTION_SKIPPED" : "BINARY_EXTRACTION_DISABLED", message: `${binariesSkipped} binary or document artifacts were not text-extracted.`, count: binariesSkipped });
  return {
    artifacts, warnings, repository,
    metrics: {
      commitsScanned: artifacts.filter((a) => a.type === "commit").length,
      tagsScanned: artifacts.filter((a) => a.type === "tag").length,
      historicalPathsScanned: retainedPaths.length,
      uniqueBlobsScanned: artifacts.filter((a) => a.type === "git_blob").length,
      textBytesScanned: textBytes,
      blobsSkippedLarge: skippedLarge,
      blobsSkippedBudget: skippedBudget
      ,commitTreesEnumerated: Math.min(commitOids.length, maxCommitTrees)
      ,blobsSkippedFiltered: skippedFiltered
      ,blobsLoadedFromCache: cachedBlobs
      ,binariesExtracted
      ,binariesSkipped
    }
  };
}

function isLowValuePath(path: string) {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return /(^|\/)(node_modules|vendor|vendors|dist|build|coverage|\.next)\//.test(normalized)
    || /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|cargo\.lock|poetry\.lock)$/.test(normalized)
    || /(?:\.min\.(?:js|css)|\.map)$/.test(normalized);
}

function appendBlobArtifact(artifacts: Artifact[], repository: string, oid: string, size: number, text: string, occurrenceMap: Map<string, Array<{ path: string; commitOid: string }>>, paths: Map<string, string>, extraProvenance: Record<string, unknown> = {}) {
  const occurrences = occurrenceMap.get(oid) ?? [];
  artifacts.push({ id: `blob:${oid}`, type: "git_blob", text, contentHash: oid, repository, path: occurrences[0]?.path ?? paths.get(oid), occurrences, provenance: { oid, byteSize: size, occurrenceCount: occurrences.length, ...extraProvenance } });
}
