import { createHash } from "node:crypto";
import { normalizeIdentity } from "./aliases.ts";
import type { Artifact, EvidenceMatch, Finding, IdentityAlias, IdentityProfile } from "./types.ts";

const ATTRIBUTION = /\b(?:built|created|developed|made|maintained|written)\s+by\s+(?:\[|\*{1,2}|_)?([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,3})|\bmy name is\s+(?:\[|\*{1,2}|_)?([\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){0,3})/giu;
const URL = /https?:\/\/[^\s<>"')\]]+/giu;
const EMAIL = /(?<![\w.+-])[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+(?![\w@])/giu;

function escapeRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function excerpt(text: string, start: number, end: number) {
  const from = Math.max(0, start - 90), to = Math.min(text.length, end + 90);
  return `${from ? "…" : ""}${text.slice(from, to).replace(/\s+/g, " ").trim()}${to < text.length ? "…" : ""}`;
}

function makeFinding(artifact: Artifact, category: Finding["category"], severity: Finding["severity"], confidence: number, summary: string, matches: EvidenceMatch[]): Finding {
  const { text, ...artifactRef } = artifact;
  const first = matches[0];
  return {
    id: createHash("sha256").update(`${artifact.id}:${category}:${first.start}:${first.value}`).digest("hex").slice(0, 20),
    layer: category === "self_attribution" ? "inferred" : "observed",
    category, severity, confidence, summary,
    evidenceSpan: excerpt(text, first.start, first.end), artifact: artifactRef, matches
  };
}

export function matchArtifact(artifact: Artifact, profile: IdentityProfile, aliases: IdentityAlias[]): Finding[] {
  const matches: EvidenceMatch[] = [];
  const occupiedAliasRanges: Array<[number, number]> = [];
  for (const alias of aliases) {
    if (alias.normalized.length < 3) continue;
    const regex = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(alias.value)}(?![\\p{L}\\p{N}_])`, "giu");
    for (const hit of artifact.text.matchAll(regex)) {
      const end = hit.index + hit[0].length;
      if (occupiedAliasRanges.some(([start, occupiedEnd]) => hit.index >= start && end <= occupiedEnd)) continue;
      occupiedAliasRanges.push([hit.index, end]);
      matches.push({ kind: "alias", value: hit[0], start: hit.index, end, confidence: alias.confidence });
    }
  }
  const knownEmails = new Set(profile.emails.map(normalizeIdentity));
  for (const hit of artifact.text.matchAll(EMAIL)) {
    const isNoreply = /(?:^|\+)noreply@|@users\.noreply\.github\.com$/i.test(hit[0]);
    matches.push({ kind: "email", value: hit[0], start: hit.index, end: hit.index + hit[0].length, confidence: knownEmails.has(normalizeIdentity(hit[0])) ? 1 : isNoreply ? 0.55 : 0.92 });
  }
  const urls: EvidenceMatch[] = [...artifact.text.matchAll(URL)].map((hit) => ({ kind: "url", value: hit[0], start: hit.index, end: hit.index + hit[0].length, confidence: 0.4 }));

  const findings: Finding[] = [];
  for (const hit of artifact.text.matchAll(ATTRIBUTION)) {
    const named = hit[1] ?? hit[2] ?? "";
    const alias = aliases.find((candidate) => normalizeIdentity(named).startsWith(candidate.normalized));
    if (!alias) continue;
    const evidence: EvidenceMatch = { kind: "attribution", value: named, start: hit.index, end: hit.index + hit[0].length, confidence: Math.min(0.98, alias.confidence + 0.06) };
    findings.push(makeFinding(artifact, "self_attribution", "high", evidence.confidence, `Attribution phrase links “${named}” to authorship or ownership.`, [evidence]));
  }
  for (const kind of ["alias", "email"] as const) {
    const grouped = matches.filter((match) => match.kind === kind && !findings.some((finding) => match.start >= finding.matches[0].start && match.end <= finding.matches[0].end));
    if (!grouped.length) continue;
    const primary = grouped.reduce((best, match) => match.confidence > best.confidence ? match : best);
    const supportingUrls = urls.filter((url) => grouped.some((match) => Math.abs(url.start - match.start) <= 160));
    const category = kind === "email" ? "email" : "identity_alias";
    const severity = kind === "email" && primary.confidence >= 0.9 ? "high" : kind === "alias" && primary.confidence >= 0.9 ? "medium" : "low";
    findings.push(makeFinding(artifact, category, severity, primary.confidence, `${kind === "alias" ? "Identity alias" : "Email address"} “${primary.value}” appears ${grouped.length} time${grouped.length === 1 ? "" : "s"} in ${artifact.type === "commit" ? "commit metadata" : artifact.path ?? "a historical blob"}.`, [...grouped, ...supportingUrls]));
  }
  return findings;
}
