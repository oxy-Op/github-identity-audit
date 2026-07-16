# Architecture compliance audit

This audit maps the supplied recommended architecture to executable code. “Boundary” means the interface and failure semantics are implemented, while a provider or external service must still be configured. “Credential-bound” means the code exists but could not be exercised without a secret that is intentionally not bundled.

## Stack and topology

| Requirement | Status | Evidence / limitation |
| --- | --- | --- |
| TypeScript, Node.js, monorepo | Implemented | Root npm/pnpm workspaces; strict TypeScript. |
| Next.js web UI | Implemented | `apps/dashboard`; production build is network-independent. |
| Fastify API | Implemented | `apps/gateway`; enqueue, status, and report endpoints with injection tests. |
| CLI and in-process runner | Implemented | `apps/cli`, `packages/coordinator`, and `packages/runtime`. |
| SQLite + FTS5 | Implemented | Full schema, artifact search, chunks, vectors, evidence, budgets, and warnings. |
| Native streaming Git | Implemented | Mirrors, updates, `rev-list`, batch checks, streaming `cat-file --batch`, commit trees, tags, and filenames. |
| PostgreSQL, BullMQ, S3 adapters | Implemented as hosted adapters | Atomic PostgreSQL lease, bounded BullMQ retention, and S3-compatible byte storage have executable contract tests. Deployment clients/services are not bundled. |
| pgvector hosted | Boundary only | Hosted SQL client boundary exists, but a production pgvector migration/query adapter is not implemented. |
| Local vector storage | Implemented | Float32 vectors persist in SQLite and are cosine-ranked with FTS5 results. This uses portable application-side cosine rather than requiring a SQLite vector extension. |
| Local inference | Boundary only | Local embedding implementation can be injected; an ONNX model/runtime is not bundled. |
| Validation | Implemented at external boundaries | Fastify request schemas and explicit CLI/worker validation. |
| Static HTML/JSON reports | Implemented | Full and redacted variants. PDF export remains the architecture’s stated later step. |
| Structured logs and metrics | Implemented | Worker JSON events and per-stage report metrics. |

## Pipeline

| Requirement | Status | Evidence / limitation |
| --- | --- | --- |
| Trusted vs derived aliases | Implemented | Alias origin/confidence retained; semantic and LLM origins cannot silently become user seeds. |
| Immutable GitHub identity | Implemented | Database ID and GraphQL node ID are captured alongside the username. |
| Profile, repositories, forks, gists, organizations metadata | Mostly implemented | Profile/repository/gist data are collected; organization listing is not a standalone artifact surface. |
| Issues, PRs, comments, reviews, discussions, releases, commit comments | Implemented with authentication tiers | Public search plus authenticated repository and bounded yearly GraphQL collectors. Live authenticated validation was completed against an authorized public test account. |
| Pull-request head refs | Not implemented | The scanner covers reachable repository refs; optional PR-head fetching remains open. |
| Full Git structures | Implemented | Commit identities/messages, annotated tags, unique blobs, commit trees, and bounded historical filename batches. |
| Blob deduplication and occurrences | Implemented | Content is processed by OID and every enumerated path/commit occurrence is retained. |
| Common artifacts | Implemented | Git and GitHub surfaces normalize into the same artifact/matcher path. |
| Stage A deterministic extraction | Implemented | Alias/email/URL/social handle, commit identity, attribution, package/copyright/trailer patterns, and filenames. |
| Stage B rule classification | Implemented, lightweight | Known person/organization/location signals, first-person and attribution phrases, links, source filtering, and source importance. This is deterministic, not a general-purpose NER model. |
| Document and image inspection | Provider boundaries implemented | PDF and OCR providers have explicit extracted/disabled/unsupported/failed states and Git provenance. No PDF/OCR engine is bundled. |
| External-link fetching disabled | Implemented by policy | URLs are extracted; arbitrary external pages are not crawled. |
| Hybrid retrieval | Implemented | Identity-bearing chunks, FTS5 BM25, persisted embeddings/cosine, source ranking, and cross-artifact corroboration. A dedicated identity graph is not separately persisted. |
| LLM providers | Implemented | OpenRouter, isolated Codex CLI, and no-LLM paths with structured results. |
| Reservation budget | Implemented and tested | Concurrent reservations, settlement, calls/candidates/tokens/cost, and bounded batches. |
| Three evidence layers | Implemented in schema | Observed, inferred, and linked are representable; current deterministic and semantic paths primarily emit observed/inferred. |
| Hard limits and partial reporting | Implemented | Repository/blob/text/tree/path/chunk/finding/social/LLM limits emit warnings and make the report incomplete. |

## Build-order deliverables

| Version | Status |
| --- | --- |
| 0.1 deterministic local CLI | Implemented and exercised against synthetic repositories and an authorized public test account. |
| 0.2 social surfaces | Implemented and authenticated collectors validated live; missing credentials are still reported as skipped. |
| 0.3 semantic retrieval | Implemented, including persisted chunks/vectors and SQLite-backed hybrid ranking. |
| 0.4 LLM adjudication | Implemented and opt-in; no paid/subscription call was made without credentials and explicit configuration. |
| 1.0 hosted mode | Architecture and core adapters implemented; full GitHub OAuth deployment, persistent quota storage, pgvector, and a production human-review workflow remain deployment work. |

## Verification snapshot

- Package tests: 30 passing.
- Fastify injection tests: 2 passing.
- Strict TypeScript: passing.
- Next.js production build: passing without network font downloads.
- Live public target audit: completed previously against an authorized public test account using explicit prior-name seeds and deterministic username variants.
- Authenticated deep-social verification: completed with a bounded read-only run. No credential pattern was found in generated outputs.

The implementation is a complete local-first audit product and a hosted-ready architecture. It is not accurate to call the external hosted deployment complete until the explicitly listed deployment work and credential-bound verification are performed.
