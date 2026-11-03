## Summary

<!-- What does this change do and why? Link the issue: "Closes #123". -->

Closes #

## Type of change

- [ ] Feature
- [ ] Bug fix
- [ ] Refactor / tech debt (no behaviour change)
- [ ] Database / migration
- [ ] Infrastructure / CI
- [ ] Documentation
- [ ] Dependency update

## How was this tested?

<!-- Commands you ran and what you verified manually. -->

- [ ] `make ci-local` (format, lint, Prisma, typecheck, unit tests, build, audit)
- [ ] `make db-test` (required when anything under `smartconnect-backend/`, `infrastructure/` or `tests/` changed)
- [ ] Manual verification:

## Database changes (delete if none)

- [ ] Migration authored with `make db-migration` (never `prisma db push` / `migrate dev`), reviewed SQL included in this PR
- [ ] No applied migration was edited
- [ ] New tenant tables have `organization_id`, composite tenant FKs and an RLS policy
- [ ] Backward compatible with the currently deployed version (expand → migrate → contract)
- [ ] `make db-drift` passes; `make db-docs` regenerated if the schema changed

## Security checklist

- [ ] No secrets, tokens, `.env` files or real customer data in the diff
- [ ] Tenant data is only accessed inside `withTenant()`; ids come from the authenticated request, not the body
- [ ] Inputs are validated; no raw SQL built from user input

## Screenshots / recordings (UI changes)

## Rollout and rollback notes

<!-- Feature flags, migration order, how to revert safely. -->
