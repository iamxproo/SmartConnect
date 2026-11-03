# @smartconnect/workspace-service

Sole owner of PostgreSQL schema `workspace`: workspaces, workspace membership, channels and channel membership. It is an internal service (port 3103); clients reach it through the [API gateway](../../api-gateway/README.md) under `/api/v1/orgs/{orgId}/workspaces/**`. API: [docs/api/endpoints.md](../../../docs/api/endpoints.md). Decisions: [ADR 0010](../../../docs/decisions/0010-organizations-and-membership.md) (*Proposed*).

## Run

```bash
make workspace-start        # needs the organization service on :3102
make workspace-test         # unit tests; integration suites run in make db-test
```

Configuration:
- **Required:** `DATABASE_URL` (runtime role `sc_workspace_app`) and `AUTH_JWT_PUBLIC_JWKS` / `_FILE`.
- **`ORGANIZATION_SERVICE_URL`:** defaults to `http://127.0.0.1:3102` outside production, and is required in production.
- **Shared variables:** `HOST`, `PORT` (3103), `TRUST_PROXY_HOPS` (1) and the other common ones, as in the other services.

## What it enforces (each covered by tests)

- **Organization membership:**
  - Asked of the organization service on **every** request, with the caller's own token. Removal from the organization ends access immediately.
  - An unreachable organization service answers 503, never "allowed".
- **Workspaces:**
  - **Open** workspaces are visible to and joinable by organization members.
  - **Private** workspaces are visible only to their members (404 otherwise, even for organization owners).
  - Creating one needs `workspaces.create`.
- **Channels:**
  - **Private** channels are visible only to their members, including towards workspace admins and organization owners.
  - Workspace guests see only their own channels.
  - Only workspace members can be added to channels.
- **Last admins:** the last workspace or private-channel admin cannot leave or be demoted. Membership changes run under row locks, so concurrent leaves cannot remove every admin.
- **Not built yet:** archive and delete endpoints, and outbox events.
