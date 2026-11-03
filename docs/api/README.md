# API documentation

- **[conventions.md](conventions.md)**: binding conventions for every SmartConnect HTTP API: paths, errors (RFC 9457), cursor pagination, idempotency, authentication and sessions, authorization order, rate limiting, versioning, OpenAPI contracts. *Proposed for Phase 1.*
- Real-time (Socket.IO) events: [../architecture/realtime.md](../architecture/realtime.md).
- The API gateway serves its OpenAPI 3.1 document at `/docs/openapi.json` and Swagger UI at `/docs` (development by default): [gateway README](../../smartconnect-backend/api-gateway/README.md). It documents the health endpoints and the authentication operations, with their security and rate-limit responses.
- The identity service documents its full request and response schemas at its own `/docs` (http://127.0.0.1:3101/docs locally): [identity README](../../smartconnect-backend/services/identity/README.md). Aggregating service schemas into the gateway document is a follow-up ([ADR 0009](../decisions/0009-identity-and-authentication.md#deferred-explicitly-not-built-here)).
- Per-service OpenAPI specifications and generated clients (`packages/api-contracts`) arrive with the first services in Phase 1.
