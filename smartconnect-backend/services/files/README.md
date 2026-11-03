# @smartconnect/files-service

Sole owner of PostgreSQL schema `files`: file metadata and (through a storage driver) the bytes. Internal service (port 3106); clients reach it through the [API gateway](../../api-gateway/README.md) under `/api/v1/orgs/{orgId}/files/**`. API: [docs/api/endpoints.md](../../../docs/api/endpoints.md#files-orgsorgidfiles). Decision: [ADR 0013](../../../docs/decisions/0013-collaboration-platform-expansion.md) (*Proposed*), decision 2.

## Run

```bash
make files-start        # needs the organization service on :3102; reads of others' files ask messaging on :3104
make files-test         # unit tests; integration suites run in make db-test
```

Configuration:
- **Required:** `DATABASE_URL` (runtime role `sc_files_app`) and `AUTH_JWT_PUBLIC_JWKS` / `_FILE`.
- **`ORGANIZATION_SERVICE_URL`, `MESSAGING_SERVICE_URL`:** default to `:3102` and `:3104` outside production; required in production.
- **`FILES_STORAGE_DIR`:** absolute directory of the local-filesystem driver. Defaults to `<repo>/.local/files` (gitignored) outside production and is required in production.
- **`FILES_MAX_BYTES`:** largest accepted file (default 25 MiB; 1 KiB to 100 MiB). The gateway reads the same variable for its own cap.
- **`FILES_MAX_PENDING_PER_USER`:** uploads a person may have declared but not finished (default 20). More gives `409 too_many_pending_uploads`; the cap is held under an advisory lock, so parallel requests cannot exceed it. Pending rows older than 24 hours are retired when the organization's next upload is created.
- **`FILES_MAX_CONCURRENT_UPLOADS_PER_USER`:** uploads in flight per person on this instance (default 3). More gives `429 too_many_concurrent_uploads`.
- **Staging:** partial uploads live in `<storage>/.tmp`; a sweeper removes ones older than an hour, at startup and hourly. Server timeouts: 15 s for headers, 120 s per request.
- **Shared variables:** `HOST`, `PORT` (3106), `TRUST_PROXY_HOPS` (1) and the other common ones.

## What it enforces (each covered by tests)

- **Upload:** the declared size is exact. Bytes stream into a temporary file under the storage directory (never buffered), are counted and hashed (SHA-256) while they arrive, and the transfer is aborted the moment it exceeds the declared size or the maximum. One concurrent upload wins; the file becomes `available` and the object is renamed into place only then.
- **Type:** detected from magic bytes (PNG, JPEG, GIF, WebP, PDF, UTF-8 text without NUL, ZIP-based Office documents); everything else is `application/octet-stream`. The extension and the client's header are never used. HTML and SVG are plain text, never inline.
- **Download:** `nosniff`, a restrictive CSP, `private, no-store`; `inline` only for PNG, JPEG, GIF and WebP.
- **Access:** the uploader, or whoever messaging says can see a message attaching the file (asked as the caller; an error is a 503, never "allowed"). Pending files are uploader-only. Other organizations and deleted files are 404.
- **Storage keys** are `<org>/<file>/<version>` built from server-generated ids, validated against that exact shape and contained in the storage directory.
- **Logging:** file names, bodies and tokens are never logged.
- **Not built yet:** attaching files to messages (Wave 2; messaging serves the attachments check), malware scanning, versions beyond the first, object-storage driver.
