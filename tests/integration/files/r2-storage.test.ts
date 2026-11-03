// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
// The files service with the Cloudflare R2 driver, configured as production would be (FILES_STORAGE_PROVIDER=r2),
// against a fake private bucket that verifies every signature (no real account, bucket or credentials). The Files
// API behaves as with the local driver, and authorization, organization isolation, size limits, the storage budget,
// signed links and provider failures hold.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FAKE_CREDENTIALS,
  startFakeR2,
  type FakeR2,
} from '../../../smartconnect-backend/services/files/test/fake-r2.js';
import { newOrganization, problemOf, startFiles, twoPeople, type TestFiles } from './support/files.js';

let staging: string;
const r2Env = (fake: FakeR2, extra: Record<string, string> = {}) => ({
  FILES_STORAGE_PROVIDER: 'r2',
  FILES_R2_ENDPOINT: fake.url,
  FILES_R2_BUCKET: fake.bucket,
  FILES_R2_ACCESS_KEY_ID: FAKE_CREDENTIALS.accessKeyId,
  FILES_R2_SECRET_ACCESS_KEY: FAKE_CREDENTIALS.secretAccessKey,
  FILES_STAGING_DIR: staging,
  ...extra,
});
const noSecretsIn = (files: TestFiles) => {
  const dump = files.logger.lines.join('\n');
  for (const secret of [FAKE_CREDENTIALS.secretAccessKey, 'X-Amz-Signature', 'Credential='])
    expect(dump).not.toContain(secret);
};

beforeAll(async () => {
  staging = await mkdtemp(path.join(tmpdir(), 'files-r2-staging-'));
});
afterAll(() => rm(staging, { recursive: true, force: true }));

describe('with the R2 driver', () => {
  let fake: FakeR2;
  let files: TestFiles;
  beforeAll(async () => {
    fake = await startFakeR2();
    files = await startFiles(r2Env(fake));
  });
  afterAll(async () => {
    await files.close();
    await fake.close();
  });
  beforeEach(() => {
    files.messaging.revokeAll();
    fake.mode = 'ok';
    fake.now = () => new Date();
  });

  it('stores the bytes in the private bucket and serves them through the service as before', async () => {
    const { alice } = twoPeople(files);
    const bytes = Buffer.from('quarterly notes\n');
    const file = await alice.create('notes.txt', bytes);
    expect(file).toMatchObject({ status: 'available', mimeType: 'text/plain' });
    // Org-scoped, server-shaped key; the detected type is recorded with the object.
    expect(fake.objects.get(`${alice.orgId}/${file.id}/1`)).toEqual({ body: bytes, contentType: 'text/plain' });

    const res = await alice.download(file.id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(bytes);
    expect(res.headers).toMatchObject({
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': expect.stringContaining('attachment') as unknown,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    });
    expect(fake.requests.every((r) => r.auth === 'header')).toBe(true);
  });

  it('keeps every byte behind the service: other members, other organizations, and the bucket itself refuse', async () => {
    const { orgId, alice, bob } = twoPeople(files);
    const { people } = newOrganization(files, ['eve']);
    const eve = people.eve!;
    const file = await alice.create('plan.txt', Buffer.from('secret plan'));

    for (const who of [bob, eve, eve.inOrg(orgId)]) {
      expect((await who.download(file.id)).status).toBe(404);
      expect((await who.get(`/files/${file.id}/download-url`)).status).toBe(404);
    }
    // Knowing the object's key gives nothing: the bucket answers only signed requests.
    expect((await fetch(`${fake.url}/${fake.bucket}/${orgId}/${file.id}/1`)).status).toBe(403);

    files.messaging.allow(orgId, file.id, bob.userId); // bob can now see a message attaching it
    expect((await bob.download(file.id)).body).toEqual(Buffer.from('secret plan'));
  });

  it('hands out a short-lived signed link only after the same check; it serves the bytes as decided, then expires', async () => {
    const { orgId, alice, bob } = twoPeople(files);
    const file = await alice.create('report.txt', Buffer.from('the report'));
    expect((await bob.get(`/files/${file.id}/download-url`)).status).toBe(404);

    const res = await alice.get(`/files/${file.id}/download-url`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const { url, expiresAt } = res.body as { url: string; expiresAt: string };
    expect(new URL(url).origin).toBe(fake.url);
    expect(Math.abs(Date.parse(expiresAt) - Date.now() - 60_000)).toBeLessThan(5_000);

    const served = await fetch(url);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('the report');
    expect(served.headers.get('content-disposition')).toContain('attachment');
    expect(served.headers.get('content-type')).toBe('text/plain; charset=utf-8');

    fake.now = () => new Date(Date.now() + 61_000);
    const expired = await fetch(url);
    expect(expired.status).toBe(403);
    expect(await expired.text()).toContain('Request has expired');
    files.messaging.allow(orgId, file.id, bob.userId);
    expect((await bob.get(`/files/${file.id}/download-url`)).status).toBe(200);
    noSecretsIn(files);
  });

  it('removes the object with the file; a lost object is a 404, never a broken download', async () => {
    const { alice } = twoPeople(files);
    const file = await alice.create('old.txt', Buffer.from('old'));
    expect((await alice.delete(`/files/${file.id}`)).status).toBe(204);
    expect(fake.objects.has(`${alice.orgId}/${file.id}/1`)).toBe(false);
    expect((await alice.download(file.id)).status).toBe(404);

    const lost = await alice.create('lost.txt', Buffer.from('gone'));
    fake.objects.delete(`${alice.orgId}/${lost.id}/1`); // vanished at the provider
    expect((await alice.download(lost.id)).status).toBe(404);
    expect(files.logger.lines.some((line) => line.includes('file_object_missing'))).toBe(true);
  });

  it('refuses what is too large before anything reaches the bucket, and stores each file once', async () => {
    const { alice } = twoPeople(files);
    const tooBig = await alice.post('/files', { name: 'huge.bin', sizeBytes: 25 * 1024 * 1024 + 1 });
    expect(tooBig.status).toBe(422);
    const declared = await alice.post('/files', { name: 'liar.bin', sizeBytes: 10 });
    const puts = () => fake.requests.filter((r) => r.method === 'PUT').length;
    const before = puts();
    expect((await alice.upload(declared.body.id, Buffer.alloc(20))).status).toBe(413);
    expect(puts()).toBe(before);

    const once = await alice.create('once.txt', Buffer.from('once'));
    const again = await alice.upload(once.id, Buffer.from('once'));
    expect(again.status).toBe(409);
    expect(problemOf(again).code).toBe('already_uploaded');
    expect(fake.requests.filter((r) => r.method === 'PUT' && r.path.endsWith(`/${once.id}/1`))).toHaveLength(1);
  });

  it('answers 503 when the provider is down, leaving no half-made file, and recovers', async () => {
    const { alice } = twoPeople(files);
    const kept = await alice.create('kept.txt', Buffer.from('kept'));
    fake.mode = 'outage';
    const declared = await alice.post('/files', { name: 'during.txt', sizeBytes: 6 });
    const upload = await alice.upload(declared.body.id, Buffer.from('during'));
    expect(upload.status).toBe(503);
    expect(problemOf(upload).code).toBe('storage_unavailable');
    expect(upload.headers['retry-after']).toBe('30');
    expect((await alice.get(`/files/${declared.body.id}`)).status).toBe(404); // retired, never "available"
    expect((await alice.download(kept.id)).status).toBe(503);

    fake.mode = 'ok';
    expect((await alice.download(kept.id)).body).toEqual(Buffer.from('kept'));
    expect(files.logger.lines.some((line) => line.includes('"event":"storage_failed"'))).toBe(true);
    noSecretsIn(files);
  });
});

describe('the storage budget', () => {
  it('refuses with 507 what would pass it, at declaration and upload, and frees what is deleted', async () => {
    const fake = await startFakeR2();
    // 1 MiB budget; 300 KiB already in the bucket before the service starts (counted by the startup scan).
    fake.objects.set('019a4a00-0000-7000-8000-00000000000a/019a4a00-0000-7000-8000-00000000000b/1', {
      body: Buffer.alloc(300 * 1024),
      contentType: 'application/octet-stream',
    });
    const files = await startFiles(r2Env(fake, { FILES_STORAGE_BUDGET_BYTES: String(1024 * 1024) }));
    try {
      const { alice } = twoPeople(files);
      const first = await alice.create('a.bin', Buffer.alloc(500 * 1024, 1));
      const refused = await alice.post('/files', { name: 'b.bin', sizeBytes: 300 * 1024 });
      expect(refused.status).toBe(507);
      expect(problemOf(refused).code).toBe('storage_quota_exceeded');

      // Declared while there was room; by the upload, another upload had taken it.
      const small = await alice.post('/files', { name: 'c.bin', sizeBytes: 200 * 1024 });
      expect(small.status).toBe(201);
      await alice.create('d.bin', Buffer.alloc(200 * 1024, 2));
      const late = await alice.upload(small.body.id, Buffer.alloc(200 * 1024, 3));
      expect(late.status).toBe(507);

      expect((await alice.delete(`/files/${first.id}`)).status).toBe(204);
      await alice.create('e.bin', Buffer.alloc(300 * 1024, 4));
    } finally {
      await files.close();
      await fake.close();
    }
  });
});

describe('refused credentials', () => {
  it('refuse every upload (the usage cannot be counted) instead of storing blind, and log no secret', async () => {
    const fake = await startFakeR2();
    const files = await startFiles(r2Env(fake, { FILES_R2_SECRET_ACCESS_KEY: 'a-wrong-secret-of-sufficient-length' }));
    try {
      expect(
        files.logger.lines.some((line) => line.includes('storage_usage_scan_failed') && line.includes('credentials')),
      ).toBe(true);
      const { alice } = twoPeople(files);
      const res = await alice.post('/files', { name: 'x.txt', sizeBytes: 3 });
      expect(res.status).toBe(503);
      expect(problemOf(res).code).toBe('storage_unavailable');
      expect(files.logger.lines.join('\n')).not.toContain('a-wrong-secret');
      expect(fake.objects.size).toBe(0);
    } finally {
      await files.close();
      await fake.close();
    }
  });
});
