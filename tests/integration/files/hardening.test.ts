// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment */
// Resource limits and failure ordering of the files service: pending-upload and concurrent-upload caps, abandoned
// uploads, objects never outliving a failed commit, and name search.
import { readdir } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalFileStorage } from '../../../smartconnect-backend/services/files/src/storage/local-file-storage.js';
import type {
  FileStorage,
  StagedObject,
} from '../../../smartconnect-backend/services/files/src/storage/file-storage.js';
import { migratorUrl, query } from '../../support/database.js';
import { newOrganization, problemOf, startFiles, tokenFor, type TestFiles } from './support/files.js';

/** Storage whose promote() is observable and can be made to fail. */
class SpyStorage extends LocalFileStorage implements FileStorage {
  failPromote = false;
  /** Runs after the upload committed and before the bytes are placed: where a racing DELETE can land. */
  beforePromote?: () => Promise<void>;
  readonly promoted: { key: string; status: string | undefined }[] = [];
  async stage(...args: Parameters<LocalFileStorage['stage']>): Promise<StagedObject> {
    const staged = await super.stage(...args);
    return {
      ...staged,
      promote: async (key) => {
        // What a reader sees at the moment the object appears: the row must already be committed as available.
        const [row] = await query<{ status: string }>(
          migratorUrl('files'),
          'SELECT status FROM files.files WHERE id = $1',
          [key.split('/')[1]],
        );
        this.promoted.push({ key, status: row?.status });
        if (this.failPromote) throw new Error('disk full');
        await this.beforePromote?.();
        await staged.promote(key);
      },
    };
  }
}

let files: TestFiles;
let spy: SpyStorage;
beforeAll(async () => {
  files = await startFiles(
    { FILES_MAX_PENDING_PER_USER: '3', FILES_MAX_CONCURRENT_UPLOADS_PER_USER: '1' },
    (dir) => (spy = new SpyStorage(dir)),
  );
});
afterAll(async () => {
  await files.close();
});

const statusOf = async (id: string) =>
  (await query<{ status: string }>(migratorUrl('files'), 'SELECT status FROM files.files WHERE id = $1', [id]))[0]
    ?.status;

describe('pending uploads', () => {
  it('caps declared-but-empty files per user with 409 too_many_pending_uploads, per user, and frees slots', async () => {
    const { alice, bob } = newOrganization(files).people;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await alice!.post('/files', { name: `p${i}.txt`, sizeBytes: 3 })).body.id);
    const over = await alice!.post('/files', { name: 'one-too-many.txt', sizeBytes: 3 });
    expect(over.status).toBe(409);
    expect(problemOf(over).code).toBe('too_many_pending_uploads');
    expect((await bob!.post('/files', { name: 'bobs.txt', sizeBytes: 3 })).status).toBe(201);

    expect((await alice!.delete(`/files/${ids[0]}`)).status).toBe(204); // deleting frees a slot
    expect((await alice!.post('/files', { name: 'again.txt', sizeBytes: 3 })).status).toBe(201);
    expect((await alice!.post('/files', { name: 'full-again.txt', sizeBytes: 3 })).status).toBe(409);
    expect((await alice!.upload(ids[1]!, Buffer.from('abc'))).status).toBe(200); // uploading frees one too
    expect((await alice!.post('/files', { name: 'after-upload.txt', sizeBytes: 3 })).status).toBe(201);
  });

  it('holds the cap under parallel declarations: exactly the cap is created, the rest get 409', async () => {
    const { alice } = newOrganization(files).people;
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => alice!.post('/files', { name: `race${i}.txt`, sizeBytes: 3 })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(37);
    expect(
      await query<{ n: string }>(
        migratorUrl('files'),
        "SELECT count(*) AS n FROM files.files WHERE uploaded_by_user_id = $1 AND status = 'pending_upload'",
        [alice!.userId],
      ).then((rows) => Number(rows[0]!.n)),
    ).toBe(3);
  });

  it('retires declarations abandoned for over 24 hours, and they stop counting', async () => {
    const { alice } = newOrganization(files).people;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await alice!.post('/files', { name: `old${i}.txt`, sizeBytes: 3 })).body.id);
    await query(
      migratorUrl('files'),
      "UPDATE files.files SET created_at = now() - interval '25 hours' WHERE id = ANY($1::uuid[])",
      [ids],
    );
    expect((await alice!.post('/files', { name: 'fresh.txt', sizeBytes: 3 })).status).toBe(201);
    expect(await Promise.all(ids.map(statusOf))).toEqual(['deleted', 'deleted', 'deleted']);
    expect((await alice!.upload(ids[0]!, Buffer.from('abc'))).status).toBe(404);
  });
});

describe('concurrent uploads', () => {
  it('refuses a second simultaneous upload by the same user with 429, then recovers', async () => {
    const { alice } = newOrganization(files).people;
    const a = (await alice!.post('/files', { name: 'slow.bin', sizeBytes: 10 })).body.id;
    const b = (await alice!.post('/files', { name: 'other.bin', sizeBytes: 3 })).body.id;
    if (!files.server.listening) await new Promise<void>((resolve) => files.server.listen(0, '127.0.0.1', resolve));
    const { port } = files.server.address() as AddressInfo;
    const token = await tokenFor(alice!.userId);

    const first = new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          port,
          host: '127.0.0.1',
          method: 'PUT',
          path: `/api/v1/orgs/${alice!.orgId}/files/${a}/content`,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': 10,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.write('12345'); // half the body: the upload stays in flight
      setTimeout(() => req.end('67890'), 700);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const refused = await alice!.upload(b, Buffer.from('abc'));
    expect(refused.status).toBe(429);
    expect(problemOf(refused).code).toBe('too_many_concurrent_uploads');
    expect(await first).toBe(200);
    expect((await alice!.upload(b, Buffer.from('abc'))).status).toBe(200);
  });
});

describe('commit ordering', () => {
  it('places the object only after the row is committed as available', async () => {
    const { alice } = newOrganization(files).people;
    spy.promoted.length = 0;
    const file = await alice!.create('ordered.txt', Buffer.from('hello'));
    expect(spy.promoted).toEqual([{ key: `${alice!.orgId}/${file.id}/1`, status: 'available' }]);
  });

  it('retires the file and leaves no object when placing the bytes fails', async () => {
    const { alice } = newOrganization(files).people;
    const created = await alice!.post('/files', { name: 'doomed.txt', sizeBytes: 3 });
    spy.failPromote = true;
    try {
      expect((await alice!.upload(created.body.id, Buffer.from('abc'))).status).toBe(500);
    } finally {
      spy.failPromote = false;
    }
    expect(await statusOf(created.body.id)).toBe('deleted');
    expect((await alice!.download(created.body.id)).status).toBe(404);
    const dir = path.join(files.storageDir, alice!.orgId);
    expect(await readdir(dir).catch(() => [])).toEqual([]);
    expect(await readdir(path.join(files.storageDir, '.tmp'))).toEqual([]); // the staged bytes are dropped too
  });
});

describe('a delete racing the upload', () => {
  it('leaves no bytes behind when the DELETE lands between the commit and the placing of the object', async () => {
    const { alice } = newOrganization(files).people;
    const created = await alice!.post('/files', { name: 'raced.txt', sizeBytes: 3 });
    const id = created.body.id as string;
    const key = `${alice!.orgId}/${id}/1`;
    spy.beforePromote = async () => {
      expect((await alice!.delete(`/files/${id}`)).status).toBe(204);
    };
    try {
      expect((await alice!.upload(id, Buffer.from('abc'))).status).toBe(404);
    } finally {
      spy.beforePromote = undefined;
    }
    expect(await statusOf(id)).toBe('deleted');
    await expect(spy.get(key)).rejects.toThrow();
    expect((await alice!.download(id)).status).toBe(404);
  });
});

describe('content type of an upload', () => {
  it('answers 415 at once to a JSON content type', async () => {
    const { alice } = newOrganization(files).people;
    const created = await alice!.post('/files', { name: 'x.txt', sizeBytes: 7 });
    const res = await alice!.upload(created.body.id, Buffer.from('{"a":1}'), 'application/json');
    expect(res.status).toBe(415);
    expect(await statusOf(created.body.id)).toBe('pending_upload');
  });
});

describe('name search (q)', () => {
  it('filters my own files by a case-insensitive literal substring', async () => {
    const { alice, bob } = newOrganization(files).people;
    for (const name of ['Quarterly Report.pdf', 'report-final.txt', '100%_done.txt', 'holiday.png', 'a-b.txt'])
      await alice!.create(name, Buffer.from('x'));
    await bob!.create('bob report.txt', Buffer.from('x'));
    const names = async (q: string) =>
      ((await alice!.get(`/files?q=${encodeURIComponent(q)}`)).body.data as { name: string }[])
        .map((f) => f.name)
        .sort();

    expect(await names('REPORT')).toEqual(['Quarterly Report.pdf', 'report-final.txt']);
    expect(await names('%')).toEqual(['100%_done.txt']);
    expect(await names('_')).toEqual(['100%_done.txt']);
    expect(await names('0%_d')).toEqual(['100%_done.txt']);
    expect(await names('%report')).toEqual([]); // % is not a wildcard
    expect(await names('\\')).toEqual([]); // a backslash is escaped, not a LIKE escape character
    expect(await names('nothing-matches')).toEqual([]);
    expect((await alice!.get('/files')).body.data).toHaveLength(5);
  });

  it('validates q: 1 to 100 characters', async () => {
    const { alice } = newOrganization(files).people;
    expect((await alice!.get('/files?q=')).status).toBe(422);
    expect((await alice!.get('/files?q=%20%20')).status).toBe(422);
    expect((await alice!.get(`/files?q=${'a'.repeat(101)}`)).status).toBe(422);
    expect((await alice!.get(`/files?q=${'a'.repeat(100)}`)).status).toBe(200);
  });
});
