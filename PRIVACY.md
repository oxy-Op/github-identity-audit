# Privacy and data handling

GitHub Identity Audit is a local-first tool. An audit may collect public profile data, repository history, commit identities, authored GitHub content, email addresses, aliases, URLs, and inferred identity relationships.

## Operator responsibilities

You are responsible for:

- having a lawful and ethical basis to run an audit;
- limiting collection to the minimum necessary scope;
- complying with GitHub's terms and applicable privacy laws;
- protecting generated reports, databases, mirrors, logs, and credentials;
- avoiding publication of unredacted findings; and
- deleting local data when it is no longer needed.

## Data locations

By default, audit data is written beneath the selected output directory. It may include:

- `report.json` and `report.html`;
- redacted report variants;
- `audit.sqlite` plus SQLite sidecar files;
- mirrored Git repositories; and
- structured worker logs.

These paths are ignored by the repository's `.gitignore`, but that does not encrypt or securely erase them.

## External services

Public GitHub collection sends requests to GitHub. Optional embedding and LLM providers receive only the passages selected for those stages, but those passages may still contain personal information. Review provider retention and training policies before enabling them.

## Redaction

Redacted reports reduce accidental disclosure but are not a guarantee of anonymity. Inspect reports manually before sharing them.
