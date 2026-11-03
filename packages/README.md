# packages/ — cross-tier shared packages

Libraries shared by **both** the frontend and the backend, installed through the root npm workspace
(`"packages/*"`). Each package is `@smartconnect/<name>`, `private: true`, `type: module`, with its own
`typecheck` / `test` / `build` scripts (picked up automatically by `npm run <script> --workspaces`).

**Belongs here:** event contracts (types + JSON Schemas for outbox events), API contract types generated
from OpenAPI, shared TypeScript/ESLint configuration, small dependency-free utilities.

**Never here:** Prisma schemas or clients, database credentials, or anything that lets one service reach
another service's data — that would break service ownership (docs/database/architecture.md).

Frontend-only shared code (design system, hooks) lives in `smartconnect-frontend/packages/` instead.

**Status:** planned — intentionally empty. This README keeps the directory in git (git does not track empty directories).
