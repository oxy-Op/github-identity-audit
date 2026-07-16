# Documentation

## Safe quick start

Requirements: Node.js 22.6 or newer, npm 10 or newer, and Git on `PATH`.

```bash
npm ci
npm run audit -- \
  --repo https://github.com/example-user/example-repository.git \
  --username example-user \
  --name "Example Name" \
  --output ./identity-audit-example
```

Windows users can run `setup.cmd` once, then `run-local.cmd` to open the local API and dashboard.

## Operating modes

- CLI: deterministic local repository or public-account audits.
- Gateway and dashboard: local loopback UI for scheduling and viewing audits.
- Worker: one structured JSON job through standard input.
- Optional providers: embeddings, OpenRouter, or isolated Codex CLI adjudication.

Deterministic scanning does not require an LLM or external AI provider.

## Local data boundary

Audit reports, SQLite databases, Git mirrors, logs, work directories, `.env` files, agent configuration, chats, transcripts, and credentials must remain local. The supplied `.gitignore` excludes the standard locations, but operators should inspect `git status` before every commit.

Never publish unredacted findings. Redaction reduces exposure but does not guarantee anonymity.

## Credentials

Use environment variables only. Prefer fine-grained read-only GitHub tokens and revoke any token exposed in a terminal recording, chat, screenshot, log, or report.

Copy `.env.example` only to a local ignored `.env` file. Never fill credentials into `.env.example`.

## Verification

```bash
npm run verify
npm audit --audit-level=high
```

The audit tool can produce false positives, stale evidence, or incomplete results. Review provenance and surrounding context manually before drawing conclusions.

## Reference

- [Main README](../README.md)
- [Disclaimer](../DISCLAIMER.md)
- [Privacy](../PRIVACY.md)
- [Security](../SECURITY.md)
- [Architecture](../ARCHITECTURE_COMPLIANCE.md)
- [Contributing](../CONTRIBUTING.md)
