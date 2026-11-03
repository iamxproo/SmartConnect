// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */
// Upload, download, limits, content sniffing and response headers of the files service.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratorUrl, query } from '../../support/database.js';
import { PNG, twoPeople, problemOf, startFiles, type TestFiles } from './support/files.js';

const MAX = 2048;
let files: TestFiles;
beforeAll(async () => {
  files = await startFiles({ FILES_MAX_BYTES: String(MAX) });
});
afterAll(async () => {
  await files.close();
});

const people = () => twoPeople(files);

describe('create, upload and download', () => {
  it('runs the whole flow and records the checksum, the detected type and a server-generated key', async () => {
    const { alice } = people();
    const created = await alice.post('/files', { name: 'logo.png', sizeBytes: PNG.length });
    expect(created.status).toBe(201);
    expect(created.headers.location).toBe(`/api/v1/orgs/${alice.orgId}/files/${created.body.id}`);
    expect(created.body).toMatchObject({
      name: 'logo.png',
      mimeType: 'application/octet-stream',
      sizeBytes: PNG.length,
      status: 'pending_upload',
      uploadedByUserId: alice.userId,
    });

    const uploaded = await alice.upload(created.body.id, PNG);
    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({ id: created.body.id, status: 'available', mimeType: 'image/png' });

    const download = await alice.download(created.body.id);
    expect(download.status).toBe(200);
    expect(Buffer.compare(download.body as Buffer, PNG)).toBe(0);

    const [version] = await query<{ storage_key: string; checksum_sha256: string; mime_type: string }>(
      migratorUrl('files'),
      'SELECT storage_key, checksum_sha256, mime_type FROM files.file_versions WHERE file_id = $1',
      [created.body.id],
    );
    expect(version).toEqual({
      storage_key: `${alice.orgId}/${created.body.id}/1`,
      checksum_sha256: createHash('sha256').update(PNG).digest('hex'),
      mime_type: 'image/png',
    });
    expect(await readFile(path.join(files.storageDir, version!.storage_key))).toEqual(PNG);
  });

  it('shows the metadata and lists only my available files, newest first, with a cursor', async () => {
    const { alice, bob } = people();
    const a = await alice.create('a.txt', Buffer.from('aaa'));
    const b = await alice.create('b.txt', Buffer.from('bbb'));
    const c = await alice.create('c.txt', Buffer.from('ccc'));
    await alice.post('/files', { name: 'pending.txt', sizeBytes: 3 }); // never uploaded: not listed
    await bob.create('bobs.txt', Buffer.from('bob'));

    expect((await alice.get(`/files/${a.id}`)).body).toMatchObject({ id: a.id, name: 'a.txt', mimeType: 'text/plain' });
    const first = await alice.get('/files?limit=2');
    expect(first.body.data.map((f: { id: string }) => f.id)).toEqual([c.id, b.id]);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await alice.get(`/files?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.data.map((f: { id: string }) => f.id)).toEqual([a.id]);
    expect(second.body.nextCursor).toBeNull();
    expect((await alice.get('/files?cursor=nope')).status).toBe(422);
  });

  it('validates create: sanitised name, size bounds, no unknown fields', async () => {
    const { alice } = people();
    const sanitised = await alice.post('/files', { name: '../../etc/pass\u0000wd‮.txt', sizeBytes: 5 });
    expect(sanitised.status).toBe(201);
    expect(sanitised.body.name).toBe('passwd.txt');

    for (const body of [
      { name: '..', sizeBytes: 5 },
      { name: '/', sizeBytes: 5 },
      { name: 'ok.txt', sizeBytes: 0 },
      { name: 'ok.txt', sizeBytes: -1 },
      { name: 'ok.txt', sizeBytes: 1.5 },
      { name: 'ok.txt', sizeBytes: MAX + 1 },
      { name: 'ok.txt' },
      { sizeBytes: 5 },
      { name: 'x'.repeat(1025), sizeBytes: 5 },
      { name: 'ok.txt', sizeBytes: 5, status: 'available' },
      { name: 'ok.txt', sizeBytes: 5, uploadedByUserId: alice.userId },
    ]) {
      const res = await alice.post('/files', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });
});

describe('size limits', () => {
  it('refuses more bytes than declared (413) and keeps the file pending, so the upload can be retried', async () => {
    const { alice } = people();
    const created = await alice.post('/files', { name: 'x.bin', sizeBytes: 10 });
    const tooMuch = await alice.upload(created.body.id, Buffer.alloc(11, 1));
    expect(tooMuch.status).toBe(413);
    expect((await alice.get(`/files/${created.body.id}`)).body.status).toBe('pending_upload');
    const retry = await alice.upload(created.body.id, Buffer.alloc(10, 1));
    expect(retry.status).toBe(200);
  });

  it('refuses fewer bytes than declared (422 size_mismatch)', async () => {
    const { alice } = people();
    const created = await alice.post('/files', { name: 'x.bin', sizeBytes: 10 });
    const short = await alice.upload(created.body.id, Buffer.alloc(9, 1));
    expect(short.status).toBe(422);
    expect(problemOf(short).code).toBe('size_mismatch');
    expect((await alice.get(`/files/${created.body.id}`)).body.status).toBe('pending_upload');
  });

  it('enforces the configured maximum even when the declared size is accepted', async () => {
    const { alice } = people();
    const created = await alice.post('/files', { name: 'max.bin', sizeBytes: MAX });
    expect((await alice.upload(created.body.id, Buffer.alloc(MAX * 3, 1))).status).toBe(413);
    expect((await alice.upload(created.body.id, Buffer.alloc(MAX, 1))).status).toBe(200);
  });

  it('leaves no temporary or orphan bytes after refused uploads', async () => {
    const { alice } = people();
    const created = await alice.post('/files', { name: 'x.bin', sizeBytes: 4 });
    await alice.upload(created.body.id, Buffer.alloc(100));
    await alice.upload(created.body.id, Buffer.alloc(1));
    expect(await readdir(path.join(files.storageDir, '.tmp'))).toEqual([]);
    await expect(readdir(path.join(files.storageDir, alice.orgId, created.body.id))).rejects.toThrow();
  });

  it('accepts only application/octet-stream content', async () => {
    const { alice } = people();
    const created = await alice.post('/files', { name: 'x.txt', sizeBytes: 3 });
    for (const type of ['application/json', 'text/plain', 'image/png']) {
      expect((await alice.upload(created.body.id, Buffer.from('abc'), type)).status, type).toBe(415);
    }
    expect((await alice.upload(created.body.id, Buffer.from('abc'))).status).toBe(200);
  });

  it('refuses a second upload to an available file and keeps the first content', async () => {
    const { alice } = people();
    const file = await alice.create('once.txt', Buffer.from('first'));
    const again = await alice.upload(file.id, Buffer.from('other'));
    expect(again.status).toBe(409);
    expect(problemOf(again).code).toBe('already_uploaded');
    expect(((await alice.download(file.id)).body as Buffer).toString()).toBe('first');
  });

  it('lets exactly one of two concurrent uploads win', async () => {
    const { alice } = people();
    const created = await alice.post('/files', { name: 'race.txt', sizeBytes: 5 });
    const results = await Promise.all([
      alice.upload(created.body.id, Buffer.from('AAAAA')),
      alice.upload(created.body.id, Buffer.from('BBBBB')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results.findIndex((r) => r.status === 200) === 0 ? 'AAAAA' : 'BBBBB';
    expect(((await alice.download(created.body.id)).body as Buffer).toString()).toBe(winner);
  });
});

describe('content sniffing never trusts the name', () => {
  it('serves HTML and SVG named .png as plain-text downloads', async () => {
    const { alice } = people();
    for (const body of [
      '<html><script>alert(1)</script></html>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="x"/>',
    ]) {
      const file = await alice.create('photo.png', Buffer.from(body));
      expect(file.mimeType).toBe('text/plain');
      const res = await alice.download(file.id);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
    }
  });

  it('detects real images whatever the name says', async () => {
    const { alice } = people();
    const file = await alice.create('notes.txt', PNG);
    expect(file.mimeType).toBe('image/png');
    expect((await alice.download(file.id)).headers['content-disposition']).toMatch(/^inline;/);
  });

  it('treats unknown binary as octet-stream, and recognises PDF and JPEG', async () => {
    const { alice } = people();
    expect((await alice.create('a.dat', Buffer.from([1, 2, 3, 0, 4]))).mimeType).toBe('application/octet-stream');
    expect((await alice.create('a.pdf', Buffer.from('%PDF-1.7\n1 0 obj'))).mimeType).toBe('application/pdf');
    expect((await alice.create('a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]))).mimeType).toBe('image/jpeg');
  });
});

describe('download headers', () => {
  it('sends the safe set for an inline image', async () => {
    const { alice } = people();
    const file = await alice.create('Ünï "cödé".png', PNG);
    const res = await alice.download(file.id);
    expect(res.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(PNG.length),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
    });
    expect(res.headers['content-disposition']).toBe(
      `inline; filename="_n_ _c_d__.png"; filename*=UTF-8''%C3%9Cn%C3%AF%20%22c%C3%B6d%C3%A9%22.png`,
    );
  });

  it('makes PDF and other types downloads, never inline', async () => {
    const { alice } = people();
    for (const [name, bytes] of [
      ['report.pdf', Buffer.from('%PDF-1.4 x')],
      ['page.html', Buffer.from('<h1>x</h1>')],
      ['blob.bin', Buffer.from([0, 1, 2])],
    ] as const) {
      const res = await alice.download((await alice.create(name, bytes)).id);
      expect(res.headers['content-disposition'], name).toMatch(/^attachment;/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    }
  });
});

describe('logging', () => {
  it('never writes file names or bodies to the logs', async () => {
    const { alice } = people();
    await alice.create('very-secret-quarterly-name.txt', Buffer.from('very-secret-body-content'));
    const joined = files.logger.lines.join('\n');
    expect(joined).not.toContain('very-secret-quarterly-name');
    expect(joined).not.toContain('very-secret-body-content');
  });
});
