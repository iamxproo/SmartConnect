# Security policy

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for security problems.**

Report privately through GitHub: **Security → Report a vulnerability** on this repository (private vulnerability reporting must be enabled by a repository admin, see [docs/devops/github-repository-setup.md](docs/devops/github-repository-setup.md)). Include:
- affected component (service, frontend app, infrastructure) and version/commit
- impact (especially any cross-tenant data access, authentication bypass or data exposure)
- reproduction steps or proof of concept, using test data only

We aim to acknowledge reports within 2 business days and to agree a remediation timeline after triage.

## Supported versions

SmartConnect is pre-release. Only the latest `main` (and `develop`) receive security fixes.

## Handling secrets

- If you discover a committed secret, **rotate it first, then remove it**. Removing it from git history does not invalidate it.
- Database credential rotation: [docs/database/security.md#credential-rotation](docs/database/security.md#credential-rotation).
- Never paste secrets, tokens, `.env` contents or customer data into issues, PRs, logs or chat.

## Security model

- Database least privilege and tenant isolation: [docs/database/security.md](docs/database/security.md), [docs/database/tenant-isolation.md](docs/database/tenant-isolation.md)
- Dependency security checks: [docs/devops/ci.md](docs/devops/ci.md#security)
