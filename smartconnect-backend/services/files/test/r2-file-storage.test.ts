// The R2 driver against a fake private bucket (fake-r2.ts) that verifies every signature: upload, download, head,
// delete, missing objects, usage over several pages, refused credentials, outages and timeouts, invalid keys, and
// presigned links (valid, tampered, expired). No real account, bucket or credentials.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  storageKeyOf,
  StorageKeyError,
  StorageLimitError,
  StorageNotFoundError,
  StorageUnavailableError,
} from '../src/storage/file-storage.js';
import { R2FileStorage, type R2Options } from '../src/storage/r2-file-storage.js';
import { FAKE_CREDENTIALS, startFakeR2, type FakeR2 } from './fake-r2.js';

const ORG = '019a4a00-0000-7000-8000-000000000001';
const FILE = '019a4a00-0000-7000-8000-000000000002';
const KEY = storageKeyOf(ORG, FILE, 1);

let fake: FakeR2;
let staging: string;
beforeAll(async () => {
  fake = await startFakeR2();
});
afterAll(() => fake.close());
beforeEach(async () => {
  fake.objects.clear();
  fake.requests.length = 0;
  fake.mode = 'ok';
  fake.failNext = 0;
  fake.pageSize = 1000;
  fake.now = () => new Date();
  staging = await mkdtemp(path.join(tmpdir(), 'r2-staging-'));
});
afterEach(() => rm(staging, { recursive: true, force: true }));

const storageWith = (options: Partial<R2Options> = {}) =>
  new R2FileStorage({
    endpoint: new URL(fake.url),
    bucket: fake.bucket,
    region: 'auto',
    credentials: FAKE_CREDENTIALS,
    timeoutMs: 2000,
    stagingDir: staging,
    retryDelayMs: 5,
    ...options,
  });

const upload = async (storage: R2FileStorage, key: string, text: string, contentType = 'text/plain') => {
  const staged = await storage.stage(Readable.from([Buffer.from(text)]), {
    maxBytes: 1024,
    expectedBytes: Buffer.byteLength(text),
  });
  await staged.promote(key, { contentType });
  return staged;
};
const read = async (stream: Readable) => {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts).toString();
};

describe('R2FileStorage', () => {
  it('uploads the staged bytes with their SHA-256, reads them back, and removes the staged copy', async () => {
    const storage = storageWith();
    const staged = await upload(storage, KEY, 'hello world');
    expect(staged.sha256).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    expect(fake.objects.get(KEY)).toEqual({ body: Buffer.from('hello world'), contentType: 'text/plain' });
    expect(await readdir(staging)).toEqual([]);
    const { stream, sizeBytes } = await storage.get(KEY);
    expect(sizeBytes).toBe(11);
    expect(await read(stream)).toBe('hello world');
    expect(await storage.head(KEY)).toEqual({ sizeBytes: 11 });
    // Every request was signed in the header; the bucket refuses anything else.
    expect(fake.requests.every((r) => r.auth === 'header')).toBe(true);
    storage.close();
  });

  it('sends nothing to R2 when an upload breaks its limits', async () => {
    const storage = storageWith();
    await expect(
      storage.stage(Readable.from([Buffer.from('too many bytes')]), { maxBytes: 4, expectedBytes: 14 }),
    ).rejects.toBeInstanceOf(StorageLimitError);
    expect(fake.requests).toEqual([]);
    expect(await readdir(staging)).toEqual([]);
    storage.close();
  });

  it('deletes, tolerates deleting what is gone, and reports missing objects', async () => {
    const storage = storageWith();
    await upload(storage, KEY, 'bytes');
    await storage.delete(KEY);
    await storage.delete(KEY);
    expect(fake.objects.has(KEY)).toBe(false);
    await expect(storage.get(KEY)).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(await storage.head(KEY)).toBeUndefined();
    storage.close();
  });

  it('counts usage over every page of the listing', async () => {
    const storage = storageWith();
    fake.pageSize = 2;
    for (let version = 1; version <= 5; version++)
      await upload(storage, storageKeyOf(ORG, FILE, version), 'x'.repeat(version));
    expect(await storage.usage()).toEqual({ bytes: 15, objects: 5 });
    expect(fake.requests.filter((r) => r.query['list-type'] === '2')).toHaveLength(3);
    storage.close();
  });

  it('refuses keys it did not shape, before any request', async () => {
    const storage = storageWith();
    for (const bad of [
      `${ORG}/../${FILE}/1`,
      '../etc/passwd',
      `${ORG}/${FILE}/0`,
      `${ORG}/${FILE}/1/extra`,
      '',
      `${ORG.toUpperCase()}/${FILE}/1`,
    ]) {
      await expect(storage.get(bad)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.delete(bad)).rejects.toBeInstanceOf(StorageKeyError);
      expect(() =>
        storage.signedReadUrl(bad, { expiresInSeconds: 60, contentType: 'x', contentDisposition: 'x' }),
      ).toThrow(StorageKeyError);
    }
    expect(fake.requests).toEqual([]);
    storage.close();
  });

  it('reports refused credentials as a credentials failure, without the secret', async () => {
    const wrongSecret = storageWith({
      credentials: { ...FAKE_CREDENTIALS, secretAccessKey: 'wrong-secret-wrong-secret-wrong' },
    });
    const failure = await wrongSecret.get(KEY).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageUnavailableError);
    expect(failure).toMatchObject({ category: 'credentials' });
    expect((failure as Error).message).toContain('SignatureDoesNotMatch');
    expect((failure as Error).message).not.toContain('wrong-secret');
    wrongSecret.close();

    const wrongKey = storageWith({
      credentials: { ...FAKE_CREDENTIALS, accessKeyId: 'ffffffffffffffffffffffffffffffff' },
    });
    await expect(wrongKey.usage()).rejects.toMatchObject({
      category: 'credentials',
      message: expect.stringContaining('InvalidAccessKeyId') as unknown,
    });
    wrongKey.close();
  });

  it('retries transient failures, and reports an outage, a reset and a hang as unavailable', async () => {
    const storage = storageWith();
    fake.failNext = 2;
    await upload(storage, KEY, 'eventually');
    expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(3);

    fake.mode = 'outage';
    await expect(storage.get(KEY)).rejects.toMatchObject({ category: 'provider_error' });
    fake.mode = 'drop';
    await expect(storage.head(KEY)).rejects.toMatchObject({ category: 'unreachable' });
    storage.close();

    const impatient = storageWith({ timeoutMs: 100, retries: 0 });
    fake.mode = 'hang';
    await expect(impatient.get(KEY)).rejects.toMatchObject({ category: 'timeout' });
    impatient.close();
  });

  describe('presigned links', () => {
    const disposition = 'attachment; filename="report.pdf"';
    const link = (storage: R2FileStorage, key = KEY) =>
      storage.signedReadUrl(key, {
        expiresInSeconds: 60,
        contentType: 'application/pdf',
        contentDisposition: disposition,
      });

    it('serve exactly that object with the signed response headers, and nothing without a signature', async () => {
      const storage = storageWith();
      await upload(storage, KEY, '%PDF-1.7');
      const res = await fetch(link(storage));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('%PDF-1.7');
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('content-disposition')).toBe(disposition);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      // The bucket is private: the same object without a signature is refused.
      expect((await fetch(`${fake.url}/${fake.bucket}/${KEY}`)).status).toBe(403);
      storage.close();
    });

    it('cannot be bent to another object or other response headers', async () => {
      const storage = storageWith();
      const other = storageKeyOf(ORG, '019a4a00-0000-7000-8000-000000000003', 1);
      await upload(storage, KEY, 'mine');
      await upload(storage, other, 'not yours');
      const url = link(storage);
      const tampered = [
        url.replace(KEY, other),
        url.replace(encodeURIComponent('application/pdf'), encodeURIComponent('text/html')),
        url.replace(/X-Amz-Expires=60/, 'X-Amz-Expires=604800'),
      ];
      for (const bent of tampered) {
        expect(bent).not.toBe(url);
        const res = await fetch(bent);
        expect(res.status).toBe(403);
        expect(await res.text()).toContain('SignatureDoesNotMatch');
      }
      storage.close();
    });

    it('expire', async () => {
      const storage = storageWith({ now: () => new Date(Date.now() - 61_000) }); // signed 61 s ago, valid for 60
      await storageWith()
        .stage(Readable.from([Buffer.from('old')]), { maxBytes: 9, expectedBytes: 3 })
        .then((s) => s.promote(KEY));
      const res = await fetch(link(storage));
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Request has expired');
      storage.close();
    });
  });
});
