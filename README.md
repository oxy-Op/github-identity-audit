# GitHub Identity Audit

A local-first, bounded OSINT and privacy-audit tool for finding identity disclosures across public GitHub repositories, reachable Git history, and authored GitHub surfaces.

It is designed for self-audits, authorized privacy reviews, and defensive research. Deterministic scanning works without an LLM. Semantic retrieval and LLM adjudication are optional.

> [!IMPORTANT]
> This software is for self-audits, explicitly authorized privacy reviews, defensive research, and repository maintenance. Do not use it for harassment, stalking, intimidation, discrimination, targeting, or unauthorized deanonymization. Findings may be incomplete or wrong and are not proof of identity. You are responsible for lawful use, secure handling, independent verification, and compliance with GitHub's terms. Read the full [disclaimer](DISCLAIMER.md) and [privacy guidance](PRIVACY.md) before use.

## Documentation

- [Quick start and operating guide](docs/README.md)
- [Responsible-use disclaimer](DISCLAIMER.md)
- [Privacy and data handling](PRIVACY.md)
- [Security policy](SECURITY.md)
- [Architecture and implementation status](ARCHITECTURE_COMPLIANCE.md)
- [Contributing](CONTRIBUTING.md)

## Features

- Full reachable Git history through native streaming Git commands
- Commit author, committer, message, annotated-tag, filename, and unique-blob scanning
- Public GitHub profile, repository, gist, issue, pull-request, review, comment, release, and discussion collectors
- Exact, normalized, bounded-fuzzy, email, URL, social-handle, and attribution matching
- SQLite evidence store with FTS5, provenance, artifact occurrences, chunks, and embeddings
- Optional hybrid lexical/vector retrieval
- Optional OpenRouter or isolated Codex CLI adjudication with reservation-based budgets
- JSON, standalone HTML, and redacted reports
- CLI, Fastify API, Next.js dashboard, and worker entry points
- Explicit warnings whenever limits make an audit partial

## Requirements

- Node.js 22.6 or newer
- Git available on `PATH`
- npm 10+ or pnpm 10+

## Install

```bash
git clone https://github.com/YOUR_ORG/github-identity-audit.git
cd github-identity-audit
npm ci
```

On Windows, `setup.cmd` performs the dependency install and release checks. After setup, `run-local.cmd` starts the local API and dashboard in separate terminal windows.

## Quick start

Audit one local or remote repository:

```bash
npm run audit -- \
  --repo https://github.com/example-user/example-repository.git \
  --username example-user \
  --name "Example Name" \
  --output ./identity-audit-example
```

Audit a public GitHub account:

```bash
npm run audit -- \
  --account "https://github.com/example-user?tab=repositories" \
  --name "Example Name" \
  --output ./identity-audit-example
```

The output directory can contain unredacted personal information, an SQLite database, and mirrored Git repositories. It is ignored by the supplied `.gitignore`, but it is not encrypted.

## GitHub authentication

Public repository scanning works without a token. Authenticated API access provides higher rate limits and enables deeper public surfaces such as bounded historical contribution windows, repository comments, reviews, releases, and discussions.

Use a fine-grained, read-only token and supply it through an environment variable:

```powershell
$env:GITHUB_TOKEN = "your-read-only-token"
npm run audit -- --account "https://github.com/example-user" --name "Example Name"
```

Never place credentials in command arguments, source files, `.env` files committed to Git, generated reports, issues, or screenshots.

## Common limits

```bash
npm run audit -- \
  --account "https://github.com/example-user" \
  --name "Example Name" \
  --max-repositories 100 \
  --max-repository-kib 1000000 \
  --max-blob-bytes 5000000 \
  --max-total-bytes 250000000 \
  --max-commit-trees 5000 \
  --max-findings 10000 \
  --delete-mirrors true
```

Limits are safety controls, not completeness guarantees. A report with warnings is marked partial.

## Optional semantic retrieval

Set an OpenAI-compatible embedding endpoint through configuration and keep the key in the environment:

```powershell
$env:EMBEDDING_API_KEY = "..."
npm run audit -- `
  --account "https://github.com/example-user" `
  --name "Example Name" `
  --embedding-endpoint "https://provider.example/v1/embeddings" `
  --embedding-model "your-embedding-model"
```

Selected identity-bearing passages may be sent to the configured provider. Review its retention and training policies first.

## Optional LLM adjudication

Deterministic findings do not require an LLM.

For OpenRouter:

```powershell
$env:OPENROUTER_API_KEY = "..."
npm run audit -- `
  --account "https://github.com/example-user" `
  --name "Example Name" `
  --llm openrouter `
  --model "configured-model"
```

The application enforces candidate, call, token, per-request, and estimated-cost limits. Provider billing and retention remain the operator's responsibility.

## Web UI and API

Run these in separate terminals:

```bash
npm run dev:api
npm run dev:web
```

Open `http://127.0.0.1:3000`. The Fastify gateway defaults to `http://127.0.0.1:4318`.

The development gateway stores jobs in memory and is intended for local loopback use. Do not expose it publicly without authentication, authorization, quotas, isolated workers, output access controls, and a retention policy.

## Worker

The worker accepts one JSON job on standard input and writes structured logs to standard error:

```bash
echo '{"account":"https://github.com/example-user","names":["Example Name"],"output":"./identity-audit-worker"}' | npm run worker
```

## Reports and interpretation

Evidence is classified into:

- **Observed** — deterministic content or metadata exists.
- **Inferred** — context suggests identity attribution.
- **Linked** — combined evidence suggests two identities are related.

An inferred or linked result is not proof. Inspect provenance, historical occurrence, authorship, surrounding text, and corroboration before acting.

Redacted reports reduce accidental exposure but do not guarantee anonymity. Manually inspect anything before sharing it.

## Development

```bash
npm test
npm run check
npm run build:api
npm run build:web
```

The test suite uses synthetic identities and temporary repositories. Contributions must not add real-person audit data or generated reports. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Architecture

The monorepo contains:

- `apps/cli` — command-line entry point
- `apps/gateway` — Fastify API
- `apps/dashboard` — Next.js UI
- `apps/worker` — structured worker process
- `packages/core` — types, aliases, and deterministic matching
- `packages/github-client` — bounded GitHub API collection
- `packages/git-scanner` — streaming native-Git scanner
- `packages/database` — SQLite/FTS5 evidence persistence
- `packages/retrieval` — chunking, embeddings, hybrid retrieval, and ranking
- `packages/llm` and `packages/budget` — optional adjudication and hard budgets
- `packages/report` — full and redacted reports
- `packages/hosted` and `packages/runtime` — hosted-mode and job-runner boundaries

See [ARCHITECTURE_COMPLIANCE.md](ARCHITECTURE_COMPLIANCE.md) for implementation boundaries.

## Privacy and responsible use

- Collect the minimum necessary data.
- Prefer self-audits and explicit authorization.
- Do not publish unredacted evidence.
- Protect and delete outputs when finished.
- Do not treat username similarity as identity proof.
- Respect GitHub's terms, rate limits, and applicable law.
- Local audit outputs, mirrors, databases, environment files, agent configuration, and conversation/work files are ignored by Git. The software does not upload them to this repository.

## License

[MIT](LICENSE)
