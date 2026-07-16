import test from "node:test";
import assert from "node:assert/strict";
import { generateAliases } from "./aliases.ts";
import { matchArtifact } from "./matcher.ts";

const profile = { githubUsername: "sasha-777", names: [], emails: [] };
const artifact = (text: string) => ({ id: "a", type: "git_blob" as const, text, contentHash: "a", repository: "demo", path: "README.md", provenance: {} });

test("finds deterministic self attribution", () => {
  const findings = matchArtifact(artifact("This product is built by Sasha."), profile, generateAliases(profile));
  assert.equal(findings[0].category, "self_attribution");
  assert.equal(findings[0].severity, "high");
});

test("finds markdown-linked attribution", () => {
  const profile = { githubUsername: "sasha-777", names: ["Sasha"], emails: [] };
  const findings = matchArtifact(artifact("An API wrapper created by [Sasha](https://github.com/sasha-777)."), profile, generateAliases(profile));
  assert.equal(findings.some((item) => item.category === "self_attribution"), true);
});

test("does not treat third-party thanks as self attribution", () => {
  const findings = matchArtifact(artifact("Thanks to Sasha for fixing the build."), profile, generateAliases(profile));
  assert.equal(findings.some((item) => item.category === "self_attribution"), false);
});

test("finds an email followed by sentence punctuation", () => {
  const withEmail = { ...profile, emails: ["sasha@example.com"] };
  const findings = matchArtifact(artifact("Contact Sasha at sasha@example.com."), withEmail, generateAliases(withEmail));
  assert.equal(findings.some((item) => item.category === "email"), true);
});

test("extracts previously unknown non-noreply email disclosures", () => {
  const findings = matchArtifact(artifact("Contact: private@example.com"), profile, generateAliases(profile));
  const email = findings.find((item) => item.category === "email");
  assert.equal(email?.severity, "high");
  assert.equal(email?.matches[0].value, "private@example.com");
});

test("does not emit generic URLs as standalone findings", () => {
  const findings = matchArtifact(artifact("Docs: https://example.com/docs"), profile, generateAliases(profile));
  assert.equal(findings.length, 0);
});
