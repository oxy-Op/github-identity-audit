# Security policy

## Reporting a vulnerability

Please do not open a public issue for vulnerabilities, exposed credentials, or reports containing personal information.

Use GitHub's private security-advisory feature for this repository. Include:

- affected version or commit;
- reproduction steps using synthetic data;
- expected and observed behavior;
- potential privacy or security impact; and
- a proposed mitigation, if available.

Do not include real access tokens, private repositories, audit databases, generated reports, or unredacted personal data.

## Supported versions

Until the project publishes tagged releases, only the latest commit on the default branch is supported.

## Credential handling

- Supply credentials through environment variables, never CLI arguments.
- Prefer fine-grained, read-only GitHub tokens.
- Never commit `.env` files or generated audit outputs.
- Revoke any credential that appears in logs, terminal history, screenshots, issues, or commits.
- Treat HTML, JSON, SQLite databases, Git mirrors, and worker logs as potentially sensitive.

## Deployment warning

The local gateway is intended for loopback use. Do not expose it publicly without authentication, authorization, request quotas, isolated workers, encrypted secret storage, output access controls, and automatic data retention/deletion policies.
