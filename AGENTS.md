# RD-Sync Agent Guidelines

## Communication and Artifacts

- Reply to the project owner in Spanish when they use Spanish.
- Keep generated technical artifacts, code comments, identifiers, tests, and docs in English unless the target file or UI context clearly requires Spanish.
- Operator-facing UI for RD-Sync is for Dominican banking staff; prefer clear professional Spanish for localized UI copy.

## Code Standards

- Use TypeScript strictness and explicit domain names; avoid `any` unless a boundary truly requires it.
- Prefer small pure helpers for behavior that needs deterministic tests.
- Keep authz on the backend. UI checks are affordances, not security boundaries.
- Do not expose internal error messages, secrets, tokens, database URLs, or queue diagnostics to browser responses or toasts.
- Keep tests behavior-focused. Cover visible contracts, authorization boundaries, empty states, and failure paths.

## Verification

Before committing meaningful changes, run:

```bash
pnpm test
pnpm lint
pnpm typecheck
git diff --check
```

If a narrower targeted test is used during development, run the full gate before commit unless the maintainer explicitly approves otherwise.

## Git Hygiene

- Use Conventional Commits.
- Never add `Co-Authored-By` or AI attribution.
- Stage only intentional files.
- Never commit `.env`, `.env*.local`, `.claude/`, generated Prisma output, build artifacts, or dependency folders.
- Keep local tooling and agent state out of product commits.
