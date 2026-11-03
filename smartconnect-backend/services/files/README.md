# @smartconnect/files-service

Sole owner of PostgreSQL schema `files`: file metadata and (through a storage driver: a local directory, or Cloudflare R2, [ADR 0018](../../../docs/decisions/0018-r2-file-storage.md)) the bytes. Internal service (port 3106); clients reach it through the [API gateway](../../api-gateway/README.md) under `/api/v1/orgs/{orgId}/files/**`. API: [docs/api/endpoints.md](../../../docs/api/endpoints.md#files-orgsorgidfiles). Decision: [ADR 0013](../../../docs/decisions/0013-collaboration-platform-expansion.md) (*Proposed*), decision 2.

## Run

```bash
make files-start        # needs the organization service on :3102; reads of others' files ask messaging on :3104
make files-test         # unit tests; integration suites run in make db-test
```

Configuration:
- **Required:** `DATABASE_URL` (runtime role `sc_files_app`) and `AUTH_JWT_PUBLIC_JWKS` / `_FILE`.
- **`ORGANIZATION_SERVICE_URL`, `MESSAGING_SERVICE_URL`:** default to `:3102` and `:3104` outside production; required in production.
- **`FILES_STORAGE_PROVIDER`:** `local` (the default outside production) or `r2`. **Required in production.**
- **`FILES_STORAGE_DIR`:** absolute directory of the local-filesystem driver. Defaults to `<repo>/.local/files` (gitignored) outside production; required in production with `local`.
- **R2 (`FILES_STORAGE_PROVIDER=r2`):**
  - `FILES_R2_ENDPOINT`: `https://<account id>.r2.cloudflarestorage.com`. In production only an R2 host is accepted; outside production a loopback `http://` endpoint (a local fake) is too.
  - `FILES_R2_BUCKET`: a private bucket.
  - `FILES_R2_ACCESS_KEY_ID`, `FILES_R2_SECRET_ACCESS_KEY` (or `_FILE`): an R2 API token with Object Read & Write on that bucket only. A secret: never in the repository or the web app.
  - Optional: `FILES_R2_REGION` (`auto`), `FILES_R2_TIMEOUT_MS` (30000), `FILES_STAGING_DIR` (where uploads are staged before they are sent; default `<os tmpdir>/smartconnect-files-staging`).
- **`FILES_STORAGE_BUDGET_BYTES`:** total bytes the application lets the storage hold (default 10,000,000,000: R2's free 10 GB). An upload that would pass it gives `507 storage_quota_exceeded`, at declaration and again at upload. It is counted from the storage itself (a listing at startup and every `FILES_STORAGE_USAGE_SCAN_SECONDS`, default 900) plus this process's uploads and deletions in between; while it cannot be counted, uploads give `503 storage_unavailable`. **It is a guard in the application, not a billing cap at Cloudflare.**
- **`FILES_SIGNED_URL_TTL_SECONDS`:** lifetime of a signed download link (R2 only; default 60, 10–600).
- **`FILES_MAX_BYTES`:** largest accepted file (default 25 MiB; 1 KiB to 100 MiB). The gateway reads the same variable for its own cap.
- **`FILES_MAX_PENDING_PER_USER`:** uploads a person may have declared but not finished (default 20). More gives `409 too_many_pending_uploads`; the cap is held under an advisory lock, so parallel requests cannot exceed it. Pending rows older than 24 hours are retired when the organization's next upload is created.
- **`FILES_MAX_CONCURRENT_UPLOADS_PER_USER`:** uploads in flight per person on this instance (default 3). More gives `429 too_many_concurrent_uploads`.
- **Staging:** partial uploads live in `<storage>/.tmp` (local) or `FILES_STAGING_DIR` (R2); a sweeper removes ones older than an hour, at startup and hourly. Server timeouts: 15 s for headers, 120 s per request.
- **Shared variables:** `HOST`, `PORT` (3106), `TRUST_PROXY_HOPS` (1) and the other common ones.

## What it enforces (each covered by tests)

- **Upload:** the declared size is exact. Bytes stream into a temporary file (never buffered in memory), are counted and hashed (SHA-256) while they arrive, and the transfer is aborted the moment it exceeds the declared size or the maximum: nothing reaches R2 unless every byte arrived. One concurrent upload wins; the file becomes `available` and the object is renamed into place (local) or PUT with its SHA-256, which R2 verifies, only then. A storage failure retires the file and answers `503 storage_unavailable` (with `Retry-After`).
- **Type:** detected from magic bytes (PNG, JPEG, GIF, WebP, PDF, UTF-8 text without NUL, ZIP-based Office documents); everything else is `application/octet-stream`. The extension and the client's header are never used. HTML and SVG are plain text, never inline.
- **Download:** streamed through the service as before, with either driver: `nosniff`, a restrictive CSP, `private, no-store`; `inline` only for PNG, JPEG, GIF and WebP.
- **Signed links (R2 only):** `GET …/files/{id}/download-url` gives `{ url, expiresAt }` after exactly the check a download makes. The link is presigned for that one object with these response headers (type, disposition, `private, no-store`), expires after `FILES_SIGNED_URL_TTL_SECONDS`, is never cached or logged, and cannot be changed to another object. The bucket stays private: unsigned requests are refused. Without R2: `404 signed_urls_unavailable`.
- **Access:** the uploader, or whoever messaging says can see a message attaching the file (asked as the caller; an error is a 503, never "allowed"). Pending files are uploader-only. Other organizations and deleted files are 404.
- **Storage keys** are `<org>/<file>/<version>` built from server-generated ids and validated against that exact shape by both drivers (contained in the storage directory, or the bucket path). They are not secrets: reading an object needs the service's credentials or a link it signed.
- **Logging:** file names, bodies and tokens are never logged.
- **Not built yet:** malware scanning, versions beyond the first, a per-organization storage quota, and automatic clean-up of objects whose deletion failed during an outage (they are logged and keep counting against the budget).
