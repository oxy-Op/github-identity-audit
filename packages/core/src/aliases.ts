import type { IdentityAlias, IdentityProfile } from "./types.ts";

export function normalizeIdentity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
}

function add(map: Map<string, IdentityAlias>, value: string, origin: IdentityAlias["origin"], confidence: number) {
  const normalized = normalizeIdentity(value);
  if (!normalized) return;
  const current = map.get(normalized);
  if (!current || current.confidence < confidence) map.set(normalized, { value, normalized, origin, confidence });
}

export function generateAliases(profile: IdentityProfile): IdentityAlias[] {
  const aliases = new Map<string, IdentityAlias>();
  add(aliases, profile.githubUsername, "user", 1);
  for (const name of profile.names) add(aliases, name, "user", 1);
  for (const email of profile.emails) {
    const local = email.split("@", 1)[0];
    if (local) add(aliases, local, "email_local_part", 0.8);
  }
  add(aliases, profile.githubUsername.replace(/-/g, "_"), "fuzzy_variant", 0.82);
  add(aliases, profile.githubUsername.replace(/[_.-]/g, ""), "fuzzy_variant", 0.82);
  const pieces = profile.githubUsername
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[_.-]+|(?<=\D)(?=\d)|(?<=\d)(?=\D)/u)
    .filter((piece) => /^[\p{L}][\p{L}'’-]{2,}$/u.test(piece));
  for (const piece of pieces) add(aliases, piece, "username_stem", 0.9);
  return [...aliases.values()].sort((a, b) => b.confidence - a.confidence || b.normalized.length - a.normalized.length || a.normalized.localeCompare(b.normalized));
}
