# 0006. Object storage and file security

- Status: **Proposed**. Production storage (Cloudflare R2) follows the blueprint. **The local store deviates from the blueprint** (SeaweedFS instead of MinIO) for the reason below.
- Date: 2026-11-02

## Context

Module F requires uploads and downloads in conversations and channels, previews, history, quotas, malware scanning, size/type validation, and secure links. The blueprint names Cloudflare R2 (or compatible) for production and **MinIO for local development**.

**Finding (verified 2026-11-02):**
- The `minio/minio` GitHub repository is **archived**: last push 2026-04-24. Its README states "THIS REPOSITORY IS NO LONGER MAINTAINED" and that the community edition is **distributed as source only**, with no pre-built binaries.
- It is licensed **AGPL-3.0**.
- Using it now means building and maintaining our own images of unmaintained software with no security fixes.

## Decision

| Concern | Decision |
|---|---|
| Production | Cloudflare R2 through the S3 API (`@aws-sdk/client-s3` 3.x, Apache-2.0). Private buckets only; no public ACLs |
| Local development and CI | **SeaweedFS** S3 gateway (Apache-2.0, actively maintained: release v3.33, pushed 2026-11-02) as a Compose service: pinned image, loopback-only, named volume. The code only sees an S3 endpoint, so swapping stores is configuration only |
| Upload | Client requests an upload → **files** service checks the context and the quota, creates `files` / `file_versions` rows (`pending_upload`), and returns a **presigned PUT** (multipart for large files). Object keys are server-generated (`<org>/<file>/<version>`) |
| Scanning | Object-created → media worker scans with **ClamAV** (status `scanning`), validates the real content type (magic bytes, not the client's claim) and size → `available` or `quarantined`. Nothing is downloadable before `available` |
| Download | The owning context's service authorises the user, then asks **files** for a **presigned GET** (≤ 5 min, `Content-Disposition: attachment` for active content types). Links are never stored or reused |
| Previews | Thumbnails and PDF/video previews as `file_renditions` (G-24), produced by the media worker, served through the same presigned-GET path |
| Avatars | Separate bucket, served via CDN; identity owns the upload flow |
| Quotas | Per-organization quotas enforced at upload request time (G-25) |
| External links | `file_share_links` with hashed tokens and expiry only if approved (G-26). Default: no anonymous links |

## Consequences

- File bytes never transit the API servers.
- **Permission enforcement stays in the owning context:** a file shared into a channel is downloadable by exactly the people who can read that message. That satisfies acceptance scenarios 5 and 6, which are tested in Phase 3.
- **Store compatibility must be verified in a Phase 3 spike against both SeaweedFS and R2:** presigned PUT/GET, multipart, CORS, `Content-Disposition`. R2 differs from AWS S3 (no object ACLs, its own CORS rules).

## Alternatives for the local store

| Option | Assessment |
|---|---|
| MinIO (as in the blueprint) | Archived, source-only, AGPL-3.0. **Not recommended** |
| RustFS | Apache-2.0, active, MinIO-like UX, but young (1.0.4). A reasonable fallback if SeaweedFS falls short in the spike |
| Garage | Lightweight and maintained, but AGPL-3.0 |
| Adobe S3Mock | Apache-2.0, good for unit tests; not a realistic dev store |
| A real R2 bucket for development | Needs internet and credentials on every laptop; no offline CI |

**Needs from the owner:** approval to use SeaweedFS instead of MinIO locally.
