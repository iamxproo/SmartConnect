# 0018. Cloudflare R2 storage driver for files, and an application storage budget

- Status: **Proposed**: implemented and verified locally against a fake bucket (2026-11-04). No real account, bucket or credentials exist yet; not deployed.
- Date: 2026-11-04
- Builds on: [ADR 0006](0006-object-storage-and-file-security.md) (R2 for objects), [ADR 0013](0013-collaboration-platform-expansion.md) decision 2 (files service, local driver). Answers part of [ADR 0016](0016-unified-backend.md) P1: the provider (Cloudflare R2) and the client (no SDK). Still open in P1: the account, the bucket and the credentials.
- Results: `UNIFIED_BACKEND_PHASE0_REPORT.md`, addendum "Workstream 2: cloud file storage".

## Context

The files service stored bytes on the local filesystem through a `FileStorage` interface (stage, promote, get, delete, sweep). A Render instance's disk is lost on redeploy, so production needs durable, private object storage. The target is Cloudflare R2's free tier: 10 GB of storage and a monthly allowance of operations, with paid usage beyond it.

Constraints:
- Files API contracts and behaviour unchanged.
- Authorization and organization isolation unchanged.
- No schema, migration, role or RLS change.
- No new dependency without approval.
- Local development and the tests need no credentials.

## Decision

1. **One more driver behind the same interface.**
   - `R2FileStorage` implements `FileStorage`, which gains `head` (existence and size), `usage` (stored bytes and objects) and, for object storage, `signedReadUrl`.
   - The service's business logic does not know which driver is in use.
   - `FILES_STORAGE_PROVIDER` selects `local` (the default outside production) or `r2`, and is **required in production**.
2. **S3 API with SigV4, written in-house** on `node:crypto` and `node:http(s)`: no AWS SDK.
   - The signer is checked against AWS's published examples: the SigV4 test suite's get-vanilla; S3 GET, PUT, lifecycle and list; and the presigned URL.
   - Path-style requests to `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`.
3. **Stage locally, then upload whole.**
   - Upload bytes stream into a private temporary file while they are counted, checked against the declared size and the 25 MiB maximum, sniffed and hashed. This is the same code the local driver uses.
   - Only after the database claim does the driver PUT the file to R2 with `x-amz-content-sha256` set to its SHA-256, which R2 verifies.
   - Nothing reaches R2 for a refused upload.
4. **Private bucket; downloads unchanged.**
   - `GET …/content` still streams through the service with its safety headers, after the service's own authorization.
   - **Additionally**, `GET …/files/{id}/download-url` returns a presigned GET (default 60 s, at most 600 s).
     - It is issued after exactly the same check.
     - It is signed for that one object and for the response type, disposition and `private, no-store`, so it cannot be bent to another object or other headers.
     - It is never cached or logged.
   - The web app is not changed to use it: reading the link cross-origin needs bucket CORS, which is an infrastructure step.
5. **Safe failure.**
   - Provider failures become `StorageUnavailableError`, whose category (`unreachable`, `timeout`, `credentials`, `provider_error`, `unexpected_response`) is safe to log. A URL, signature or credential is never logged.
   - Transient failures (network, timeout, 429, 5xx) are retried twice with backoff.
   - The API answers `503 storage_unavailable` with `Retry-After`. A failed upload retires its file, never leaving a half-made one.
   - Nothing falls back to another provider. In production, the endpoint must be an R2 host, over https, with no path.
6. **Application storage budget.**
   - `FILES_STORAGE_BUDGET_BYTES` defaults to 10,000,000,000, the smaller reading of R2's "10 GB".
   - The total comes from the storage itself: R2 `ListObjectsV2`, which is what R2 bills, at startup and every `FILES_STORAGE_USAGE_SCAN_SECONDS` (default 900). This process's uploads and deletions in between are added and subtracted.
   - A declaration and an upload that would pass the budget get `507 storage_quota_exceeded`. Uploads in flight are reserved.
   - It errs on the safe side: uploads during a scan are counted on top of it, deletions during a scan wait for the next one, and an unknown total refuses uploads (`503`) instead of letting them through.
   - It is a guard inside the application, **not a provider billing cap**.
7. **Keys.** `<organization>/<file>/<version>` from server-generated ids, validated against that exact shape by both drivers before any use. They are not secrets: the bucket is private, and a read needs the service's credentials or a link the service signed.

## Consequences

- Production needs:
  - an R2 bucket;
  - an R2 API token scoped to it, with Object Read & Write;
  - `FILES_STORAGE_PROVIDER=r2`, the endpoint, the bucket and the two credentials, the secret through a secret store.
- **Budget limits:**
  - **Multiple instances:** each instance knows its own uploads between scans, so several instances can briefly pass the budget together (by at most the uploads in flight until the next scan).
  - **Other writers:** objects written by anything else are seen only at the next scan.
  - **Exact enforcement** across instances needs a database-side total: a narrow SECURITY DEFINER function returning the sum of live versions' sizes across organizations, or a counter table. That is a migration, so it awaits approval.
- **Deletion failures:** if deleting an object fails during an outage, the file is gone for everyone but the object stays. It is logged and keeps counting against the budget; there is no automatic clean-up yet.
- **Operations:** each scan is one `ListObjectsV2` per 1,000 objects (a Class A operation). Every download is one GET (Class B), and every upload one PUT (Class A). These counts are well inside the free allowance at MVP scale, but are not measured here.

## Alternatives considered

- **The AWS SDK (`@aws-sdk/client-s3`, plus a presigner).** Not taken: it would be a new, large dependency needing approval, for five operations and a presigner.
- **Redirecting `…/content` to a presigned URL.** Not taken: it would change the download behaviour, drop the service's safety headers on direct navigation, and need bucket CORS and a gateway change. It is offered as a separate, opt-in route instead.
- **Streaming uploads straight to R2 (multipart).** Not taken: limits and sniffing would have to abort a provider-side upload half-way, and the SHA-256 is only known at the end.
- **A database-based global quota now.** Not taken: it needs a migration (see Consequences).
