# Tenant isolation

Multi-tenancy is a **security boundary**. An `organization_id` UUID is an identifier, not a secret: knowing another tenant's id must never grant access. Isolation is therefore enforced in layers, and the database layers work even when application code is wrong.

## Layers

| # | Layer | Enforced by | Protects against |
|---|---|---|---|
| 1 | Authentication and organization membership | API gateway + organization service (JWT carries `sub`; membership resolved per request) | Non-members acting in an org |
| 2 | Resource-level authorization | Owning service (org role permissions → workspace role → channel role / document visibility / meeting join policy) | Members reaching resources they are not entitled to (private channels, private documents) |
| 3 | **Tenant context per transaction** | `withTenant()` in each service's `src/database/client.ts` | Unscoped queries |
| 4 | **Row-level security**, fail-closed | PostgreSQL policies on all 48 tenant tables | A forgotten `WHERE organization_id = …`, IDOR via guessed ids, cross-tenant writes |
| 5 | **Tenant-aware composite foreign keys** | `(organization_id, parent_id) → parent(organization_id, id)` | Child rows referencing another tenant's parent. Plain FK checks bypass RLS, so RLS alone would allow this |
| 6 | Schema isolation per service | Role privileges | A compromised service reading other domains |
| 7 | Narrow cross-tenant escape hatches | Reviewed `SECURITY DEFINER` functions | Workers and flows that legitimately span tenants |
| 8 | Regression guard | `tests/security/database/tenant-isolation.test.ts` | New tables without RLS; policy regressions |

Layers 1–2 are application code (not yet built). Layers 3–8 are implemented and verified.

## Tenant context

```ts
// smartconnect-backend/services/<svc>/src/database/client.ts
await withTenant(prisma, { organizationId, userId }, async (tx) => {
  // every query here is limited to organizationId by RLS
  return tx.channel.findMany({ where: { workspaceId } });
});
```

`withTenant()` opens an interactive transaction, validates both ids as UUIDs, and runs:

```sql
SELECT set_config('app.current_organization_id', $1, true),
       set_config('app.current_user_id', $2, true);   -- true = transaction-local
```

- **Transaction-local:** the settings vanish at COMMIT/ROLLBACK, so a pooled connection can never carry one tenant's context into another request. This is tested with a pool of size 1. It is also correct behind PgBouncer in transaction mode.
- **Fail closed:** policies read `NULLIF(current_setting('app.current_organization_id', true), '')::uuid`. No context means `NULL`, which matches no rows and fails every `WITH CHECK`.
- **Where the tenant id comes from:** the authenticated request (route `/orgs/:orgId/...` + membership check in layer 1), **never** from a request body.

NestJS integration (when the services are built): a request-scoped provider resolves `{ organizationId, userId }` after the membership guard, and repositories receive the transaction client from `withTenant()`. Code that receives a bare `PrismaClient` can still only see non-tenant tables.

## Policies

Standard policy (every tenant table except those listed below):

```sql
ALTER TABLE "<table>" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "<table>"
  USING      (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
```

`USING` hides other tenants' rows from SELECT/UPDATE/DELETE. `WITH CHECK` rejects INSERTs and UPDATEs that would create or move a row into another tenant (tested: `new row violates row-level security policy`).

| Schema.table | Policies | Notes |
|---|---|---|
| `organization.organizations` | `tenant_isolation` (on `id`), `member_read` (SELECT, **only when no tenant context is set**: orgs where the current user is an active member) | Organization switcher (`withUser()`) |
| `organization.organization_members` | `tenant_isolation`, `self_read` (SELECT, only without tenant context: `user_id = current user`) | A user sees their own memberships, never co-members of other tenants. Inside `withTenant()` a session sees exactly one organization (tested) |
| `organization.organization_roles` | `tenant_isolation`, `member_read` (only without tenant context) | Shows role names in the switcher |
| `organization.organization_invitations` | `tenant_isolation` | Token lookup via `resolve_invitation_token()` |
| `administration.audit_logs` | `tenant_read` (SELECT), `tenant_insert` (INSERT; NULL org allowed only with no context) | **No UPDATE/DELETE policy**, plus grants revoked and a trigger |
| all other tenant tables (42) | `tenant_isolation` | |

**Not under RLS, by design:**
- `identity.*`: accounts are global (one user, many organizations). Isolation is per user id in the identity service, and no other service can reach these tables.
- `outbox_events` / `processed_events`: infrastructure. The relay must read *every* tenant's events as the service's own role, so RLS plus a definer function would hand the same data to the same role. **Only relay code may query `outbox_events`**; services only insert into it. Revisit with the relay design.
- Table owners (migrators): RLS is not FORCEd, so migrations and backfills see all rows. Owners are never used at runtime.

## Sanctioned cross-tenant operations

| Operation | Mechanism | What it can see |
|---|---|---|
| List my organizations | `withUser(prisma, userId, …)` (organization service only) | Organizations, roles and **own** memberships where the user is an active member |
| Accept an invitation | `organization.resolve_invitation_token(token_hash)` | `(organization_id, invitation_id)` of a valid pending token, then `withTenant()` |
| Delivery workers | `notifications.claim_notification_deliveries(n, lease)`, `integrations.claim_webhook_deliveries(n, lease)` | `(organization_id, delivery_id)` pairs, leased with `SKIP LOCKED`, never after 20 attempts; processing happens in `withTenant()` |
| Platform directory (Super Admin, [ADR 0015](../decisions/0015-platform-administration.md)) | `organization.platform_organization_ids(limit, before)` and `platform_organization_count()`, behind the service's `SuperAdminGuard` | Organization ids and a total; each organization's name, status and member count are then read in `withTenant()` |
| Platform audit events (e.g. logins) | Insert with `organization_id = NULL` and no tenant context | **Write-only**: no tenant context can read them back |
| Outbox relay / event consumers | Non-RLS infrastructure tables; handlers then use `withTenant(event.organization_id)` | Event envelopes |
| Retention purges | Loop per organization in `withTenant()` (policies are per organization anyway) | One tenant at a time |

Workflow schedulers (`workflow_triggers.next_run_at`, queued `workflow_executions`) need a claim function of the same shape. Add it with the workflow engine (not yet built).

## What RLS does **not** do

- **Membership inside a tenant.** RLS stops org A from seeing org B. It does not stop a member of org A from reading a *private channel* in org A. That is layer 2, in the service. Search enforces it through `search_documents.access_scope_ids` intersected with the caller's scopes.
- **SQL injection.** Injected SQL can call `set_config` itself. Parameterised queries (Prisma, tagged `$queryRaw`) remain mandatory. `$queryRawUnsafe` is banned for request data.
- **Identity data.** No RLS on global tables; the identity service must scope every query by the authenticated user.

## Gotchas (verified)

- **`INSERT … RETURNING` must also pass the SELECT policy.** Prisma's `create()` uses RETURNING. That is why platform audit events (`organization_id IS NULL`) must be written with `createMany()`: they are visible to no tenant.
- **Nested writes inherit the tenant.** In `notification.create({ data: { deliveries: { create: { … } } } })` Prisma fills the child's `organization_id` from the parent through the composite FK, and rejects an explicit one.
- **Unique constraints are global, RLS is not.** A slug collision with another tenant still raises a unique violation (P2002). This is by design for global slugs; per-tenant uniqueness is `(organization_id, slug)`.
- **Raw SQL outside `withTenant()` sees nothing.** Background jobs must either use `withTenant()` or a claim function.

## Rules for every new table

1. If it holds tenant data: add `organization_id uuid NOT NULL`, `@@unique([organizationId, id])` if it can be a parent, and composite relations `fields: [organizationId, parentId], references: [organizationId, id]`.
2. Append to the migration: `ALTER TABLE … ENABLE ROW LEVEL SECURITY` + the `tenant_isolation` policy.
3. `make db-test`. The catalog test fails if any table with `organization_id` lacks RLS or a policy.
4. If the table must be reachable across tenants, write a narrow claim/lookup function. Never relax the policy.
