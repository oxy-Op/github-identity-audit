# Contributing

Contributions are welcome, especially improvements to bounded scanning, provenance, false-positive reduction, privacy safeguards, and synthetic test coverage.

## Before opening a change

1. Use only synthetic or clearly public, non-sensitive fixtures.
2. Never commit audit outputs, Git mirrors, tokens, private email addresses, or real-person dossiers.
3. Add regression tests for behavior changes.
4. Run:

```bash
npm test
npm run check
npm run build:api
npm run build:web
```

## Pull requests

Keep changes focused and explain:

- the privacy/security effect;
- new limits or external requests;
- any data sent to third parties;
- failure and partial-coverage behavior; and
- how the change was tested.

Security issues should follow `SECURITY.md`, not the public issue tracker.
