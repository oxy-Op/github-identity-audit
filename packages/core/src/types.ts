export type AliasOrigin = "user" | "username_stem" | "email_local_part" | "transliteration" | "fuzzy_variant" | "semantic_inference" | "llm_suggestion";

export interface IdentityAlias {
  value: string;
  normalized: string;
  origin: AliasOrigin;
  confidence: number;
}

export interface IdentityProfile {
  githubUsername: string;
  githubDatabaseId?: number;
  githubNodeId?: string;
  names: string[];
  emails: string[];
  usernames?: string[];
  domains?: string[];
  organizations?: string[];
  locations?: string[];
  socialHandles?: string[];
  options?: {
    enableFuzzyNames: boolean;
    enableSemanticSearch: boolean;
    inspectDocuments: boolean;
    inspectImages: boolean;
    fetchExternalLinks: false;
  };
}

export interface Artifact {
  id: string;
  type: "git_blob" | "commit" | "tree" | "tag" | "issue" | "issue_comment" | "pull_request" | "review" | "review_comment" | "discussion" | "commit_comment" | "release" | "gist" | "profile";
  text: string;
  contentHash: string;
  repository: string;
  path?: string;
  commitOid?: string;
  provenance: Record<string, unknown>;
  occurrences?: Array<{ path: string; commitOid: string }>;
}

export interface EvidenceMatch {
  kind: "alias" | "email" | "url" | "attribution" | "semantic";
  value: string;
  start: number;
  end: number;
  confidence: number;
}

export interface Finding {
  id: string;
  layer: "observed" | "inferred" | "linked";
  category: "identity_alias" | "semantic_identity" | "email" | "url" | "self_attribution";
  severity: "low" | "medium" | "high";
  confidence: number;
  summary: string;
  evidenceSpan: string;
  artifact: Omit<Artifact, "text">;
  matches: EvidenceMatch[];
  score?: {
    exactAlias: number;
    tokenSimilarity?: number;
    editSimilarity?: number;
    attributionContext: number;
    artifactAuthorship: number;
    sourceImportance: number;
    corroboration: number;
    urlOnlyPenalty: number;
    total: number;
  };
  adjudication?: {
    provider: string;
    relationship: string;
    subjectIsTarget: boolean;
    confidence: number;
    explanation: string;
  };
}

export interface ScanLimits { maxBlobBytes: number; maxTotalTextBytes: number; maxFindings: number; maxCommitTrees?: number; maxHistoricalPaths?: number; }
export interface ScanWarning { code: string; message: string; count?: number; }

export interface AuditReport {
  schemaVersion: "0.1";
  generatedAt: string;
  target: IdentityProfile;
  aliases: IdentityAlias[];
  source: string;
  complete: boolean;
  metrics: Record<string, number>;
  warnings: ScanWarning[];
  findings: Finding[];
}
