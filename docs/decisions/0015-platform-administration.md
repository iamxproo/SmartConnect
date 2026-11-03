# 0015. Platform administration: the Super Admin role

- Status: **Proposed**
- Date: 2026-11-03
- Extends: [ADR 0009](0009-identity-and-authentication.md) (identity and authentication) and [ADR 0010](0010-organizations-and-membership.md) (organizations; its "no platform-admin concept yet").

## Context

**What SmartConnect had before this record:**
- Administration existed only inside an organization: the `owner`, `admin` and `member` roles.
- There was no platform-wide role, no admin panel and no `/admin/login` page.

**What the product owner asked for:**
- A Super Admin who signs in at `/admin/login` and reaches a platform dashboard.
- A development account with a given initial password. The password must be:
  - hashed and never stored in plaintext;
  - seeded only in development, never in staging or production;
  - changed at the first sign-in.
- Organization admin permissions kept separate.
- Every admin API protected on the server.

**Constraints from what exists:**
- **Sign-in is by email only.** There are no usernames.
- **Access tokens carry identifiers only, never roles** (ADR 0009).
- **Passwords are Argon2id**, with a 12-character minimum on registration, reset and change.
- **No MFA is implemented** (TOTP is reserved in the schema but not approved).

## Decision

1. **One login system.**
   - `/admin/login` calls the ordinary `POST /api/v1/auth/login`. There is no second credential store, session type or token.
   - The admin page signs an account without the role straight back out. The APIs below refuse it regardless.
2. **A platform role, separate from organization roles.**
   - `identity.platform_role_assignments (user_id, role)`, where the role enum currently holds only `super_admin`.
   - The role is never put in a token. Every admin request looks it up, so withdrawing it or suspending the account takes effect at once.
   - `GET /auth/me` returns `platformRoles` and `passwordChangeRequired`, so other services can apply the same rule. Organization roles grant nothing here.
   - A Super Admin gains no organization access: an organization's own routes still require membership and answer 404.
3. **Issued passwords must be replaced.**
   - `identity.credentials.change_required` marks a password set by someone else. A CHECK constraint allows it only on password credentials.
   - Every password change or reset clears it. A required change cannot re-enter the issued password, and the new one must meet the normal 12-character policy.
   - Until the password is replaced, every admin API answers `403 password_change_required`. The web app sends the account to `/admin/password` from any page.
4. **Admin APIs are read-only for now and guarded in each service:**
   - `GET /admin/accounts/summary` (identity): account totals.
   - `GET /admin/organizations` (organization): a directory of name, address, status, member count and creation date. Never organization content.
   - Each service has a `SuperAdminGuard`. The organization service asks identity through `/auth/me`, as it already does for organization creation.
   - The gateway forwards exactly these two GET routes, and nothing else under `/admin`, and rate-limits them per user (60 per minute).
5. **Cross-tenant read:**
   - Two SECURITY DEFINER functions, `organization.platform_organization_ids(limit, before)` and `organization.platform_organization_count()`, return identifiers and a count only.
   - The service then reads each organization inside its own tenant context.
   - They follow every rule in [security.md](../database/security.md#security-definer-functions). Who may call them is the service guard's decision.
6. **The development Super Admin:**
   - `make admin-seed` creates or resets `admin@smartconnect.localhost`. `.localhost` is reserved and never routable, so no email can leave the machine.
   - The person types the initial password at a hidden prompt, twice. It reaches the seed on stdin, never through argv, the environment, a file or source. It is stored as Argon2id with `change_required`.
   - **Where the seed refuses to run:**
     - when `NODE_ENV` is anything but `development` (or unset);
     - against any database but the local development instance (local host, development port, database `smartconnect`);
     - outside an interactive terminal.
   - **Minimum length:** the initial password needs only 8 characters, because the product owner chose a short development password. It is development-only, and the first sign-in must replace it under the full policy.
   - **Re-running it** resets the password, requires a change again and ends every session of the account.
   - It uses the same runtime credentials and identity code (Prisma client, `PasswordHasher`) as `make db-seed`.
7. **Organization creation is unchanged.** ADR 0010 expected a platform role to replace the `ORGANIZATION_CREATOR_EMAILS` allowlist. For now it does not: a Super Admin gets no creation right, and the fail-closed allowlist stays the only rule.

## Consequences

- The platform has a place for platform administration, built on the existing login, sessions and password policy.
- **Two new pieces of schema:**
  - **Identity:** a table and a column (`platform_role_assignments`, `credentials.change_required`).
  - **Organization:** two functions.
  - **Tenant data:** no tenant table changes.
- **Granting the role in production is not designed.** Only the development seed creates Super Admins, and staging and production have no path yet.
- **MFA:** none exists, so none is bypassed. A Super Admin is a high-value account, so MFA should come before any production Super Admin.
- **Audit:** admin reads are not audited yet. They should be when the audit pipeline (`administration.audit_logs`) is built.
- **Requests to identity:** every admin request makes one extra `/auth/me` call from the organization service. That is acceptable for a low-traffic dashboard.

## Open points (before production)

1. How Super Admins are granted and revoked outside development, and by whom, with an audit trail.
2. MFA for Super Admins.
3. Whether a Super Admin may create organizations, replacing or extending the allowlist (ADR 0010 decision 1).
4. Which write operations the panel gets: suspending accounts or organizations, for example. Each needs its own authorization and audit design.

## Alternatives considered

| Alternative | Why not |
|---|---|
| A separate admin login with its own credential store | Duplicates authentication, sessions and password policy. The product owner asked to reuse the existing one |
| A username `admin` | Login is by email for everyone. Usernames would change the shared login path for every account |
| Roles in the access token | Not revocable before the token expires, and against ADR 0009's identifiers-only claims |
| The initial password, or its hash, in the seed source | A hash of a short password is as good as plaintext to anyone reading the repository |
| Reading organizations with RLS disabled or as the migrator | Against the database rules. A definer function returning identifiers is the sanctioned way to cross tenants |
