// Supertest response bodies are untyped JSON; the assertions below read them directly.
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
// Who may do what: authentication, organization membership, uploader-only rules, attachment-derived reads that fail
// closed, deletion, and database-level tenant isolation.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appUrl, withClient } from '../../support/database.js';
import { newOrganization, PNG, twoPeople, problemOf, startFiles, tokenFor, type TestFiles } from './support/files.js';

let files: TestFiles;
beforeAll(async () => {
  files = await startFiles();
});
afterAll(async () => {
  await files.close();
});
beforeEach(() => files.messaging.revokeAll());

describe('authentication and organization membership', () => {
  it('requires a valid token on every route', async () => {
    const { alice } = twoPeople(files);
    const file = await alice.create('a.txt', Buffer.from('abc'));
    const base = `/api/v1/orgs/${alice.orgId}/files`;
    const routes: [string, string][] = [
      ['post', base],
      ['get', base],
      ['get', `${base}/${file.id}`],
      ['put', `${base}/${file.id}/content`],
      ['get', `${base}/${file.id}/content`],
      ['delete', `${base}/${file.id}`],
    ];
    for (const [method, url] of routes) {
      const call = (request(files.server) as unknown as Record<string, (u: string) => request.Test>)[method]!;
      expect((await call(url)).status, `${method} ${url}`).toBe(401);
      expect((await call(url).set('Authorization', 'Bearer aaa.bbb.ccc')).status, `${method} ${url}`).toBe(401);
    }
  });

  it('answers 404 to people who are not members of the organization, and after removal', async () => {
    const { orgId, alice } = twoPeople(files);
    const outsider = newOrganization(files, ['eve']).people.eve!.inOrg(orgId);
    const file = await alice.create('a.txt', Buffer.from('abc'));
    expect((await outsider.get('/files')).status).toBe(404);
    expect((await outsider.post('/files', { name: 'x', sizeBytes: 1 })).status).toBe(404);
    expect((await outsider.get(`/files/${file.id}`)).status).toBe(404);
    expect((await outsider.download(file.id)).status).toBe(404);
    expect((await outsider.delete(`/files/${file.id}`)).status).toBe(404);

    files.org.revoke(orgId, alice.userId);
    expect((await alice.get(`/files/${file.id}`)).status).toBe(404);
    expect((await alice.download(file.id)).status).toBe(404);
  });

  it('never serves a file through another organization, even to someone in both', async () => {
    const { alice } = twoPeople(files);
    const b = newOrganization(files, []);
    files.org.addMember(b.orgId, alice.userId);
    const file = await alice.create('a.txt', Buffer.from('abc'));
    const viaB = alice.inOrg(b.orgId);
    expect((await viaB.get(`/files/${file.id}`)).status).toBe(404);
    expect((await viaB.download(file.id)).status).toBe(404);
    expect((await viaB.delete(`/files/${file.id}`)).status).toBe(404);
    expect((await viaB.get('/files')).body.data).toEqual([]);
    const pending = await alice.post('/files', { name: 'p.txt', sizeBytes: 3 });
    expect((await viaB.upload(pending.body.id, Buffer.from('abc'))).status).toBe(404);
  });

  it('treats malformed ids as unknown files', async () => {
    const { alice } = twoPeople(files);
    expect((await alice.get('/files/not-a-uuid')).status).toBe(404);
    expect((await alice.upload('not-a-uuid', Buffer.from('x'))).status).toBe(404);
  });
});

describe('uploader only, until messaging says otherwise', () => {
  it('hides a file from other members and never asks messaging about pending files', async () => {
    const { alice, bob } = twoPeople(files);
    const pending = await alice.post('/files', { name: 'p.txt', sizeBytes: 3 });
    const done = await alice.create('a.txt', Buffer.from('abc'));
    for (const id of [pending.body.id as string, done.id]) {
      expect((await bob.get(`/files/${id}`)).status).toBe(404);
      expect((await bob.download(id)).status).toBe(404);
      expect((await bob.delete(`/files/${id}`)).status).toBe(404);
    }
    expect((await bob.upload(pending.body.id, Buffer.from('abc'))).status).toBe(404);
    expect((await bob.get('/files')).body.data).toEqual([]);
    expect(files.messaging.requests.map((r) => r.url)).not.toContain(
      `/api/v1/orgs/${alice.orgId}/attachments/${pending.body.id}`,
    );
    expect((await alice.upload(pending.body.id, Buffer.from('abc'))).status).toBe(200); // still hers
  });

  it('lets a non-uploader read when messaging says 200, as the caller, but never write', async () => {
    const { alice, bob } = twoPeople(files);
    const file = await alice.create('shared.png', PNG);
    files.messaging.allow(alice.orgId, file.id, bob.userId);

    expect((await bob.get(`/files/${file.id}`)).body).toMatchObject({ id: file.id, name: 'shared.png' });
    const download = await bob.download(file.id);
    expect(download.status).toBe(200);
    expect(Buffer.compare(download.body as Buffer, PNG)).toBe(0);
    expect(files.messaging.requests.at(-1)).toEqual({
      url: `/api/v1/orgs/${alice.orgId}/attachments/${file.id}`,
      authorization: `Bearer ${await tokenFor(bob.userId)}`,
    });

    expect((await bob.delete(`/files/${file.id}`)).status).toBe(404);
    expect((await bob.upload(file.id, Buffer.from('x'))).status).toBe(404);
    expect((await bob.get('/files')).body.data).toEqual([]); // the list is "my own files"
    expect((await alice.get(`/files/${file.id}`)).status).toBe(200);
  });

  it('answers 404 when messaging says 404, and fails closed (503) on anything else', async () => {
    const { alice, bob } = twoPeople(files);
    const file = await alice.create('a.txt', Buffer.from('abc'));
    expect((await bob.download(file.id)).status).toBe(404);
    for (const status of [500, 502, 503, 401, 403, 429]) {
      files.messaging.failWith = status;
      const res = await bob.get(`/files/${file.id}`);
      expect(res.status, String(status)).toBe(503);
      expect(problemOf(res).code).toBe('dependency_unavailable');
      expect((await bob.download(file.id)).status, String(status)).toBe(503);
    }
  });

  it('fails closed when messaging is unreachable', async () => {
    const down = await startFiles({ MESSAGING_SERVICE_URL: 'http://127.0.0.1:9' });
    try {
      const { alice, bob } = twoPeople(down);
      const file = await alice.create('a.txt', Buffer.from('abc'));
      expect((await bob.get(`/files/${file.id}`)).status).toBe(503);
      expect((await alice.get(`/files/${file.id}`)).status).toBe(200); // the uploader needs no one's say-so
    } finally {
      await down.close();
    }
  });
});

describe('deleting', () => {
  it('makes the file unreadable for everyone, removes the bytes and cannot be repeated', async () => {
    const { alice, bob } = twoPeople(files);
    const file = await alice.create('gone.txt', Buffer.from('abc'));
    files.messaging.allow(alice.orgId, file.id, bob.userId);
    expect((await bob.get(`/files/${file.id}`)).status).toBe(200);

    expect((await alice.delete(`/files/${file.id}`)).status).toBe(204);
    for (const person of [alice, bob]) {
      expect((await person.get(`/files/${file.id}`)).status).toBe(404);
      expect((await person.download(file.id)).status).toBe(404);
    }
    expect((await alice.get('/files')).body.data).toEqual([]);
    expect((await alice.delete(`/files/${file.id}`)).status).toBe(404);
    expect((await alice.upload(file.id, Buffer.from('abc'))).status).toBe(404);
    await expect(readdir(path.join(files.storageDir, alice.orgId, file.id, '1'))).rejects.toThrow();
    const rows = await withClient(appUrl('files'), async (client) => {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_organization_id', $1, true)", [alice.orgId]);
      const res = await client.query('SELECT status, deleted_at FROM files.files WHERE id = $1', [file.id]);
      await client.query('ROLLBACK');
      return res.rows as { status: string; deleted_at: Date | null }[];
    });
    expect(rows[0]?.status).toBe('deleted');
    expect(rows[0]?.deleted_at).toBeInstanceOf(Date);
  });

  it('can delete a pending upload, which then cannot receive bytes', async () => {
    const { alice } = twoPeople(files);
    const pending = await alice.post('/files', { name: 'p.txt', sizeBytes: 3 });
    expect((await alice.delete(`/files/${pending.body.id}`)).status).toBe(204);
    expect((await alice.upload(pending.body.id, Buffer.from('abc'))).status).toBe(404);
  });
});

describe('row-level security', () => {
  it('shows each organization only its own rows and nothing without a tenant context', async () => {
    const a = twoPeople(files);
    const b = twoPeople(files);
    const fileA = await a.alice.create('a.txt', Buffer.from('aaa'));
    const fileB = await b.alice.create('b.txt', Buffer.from('bbb'));

    const idsSeenBy = (orgId: string | undefined) =>
      withClient(appUrl('files'), async (client) => {
        await client.query('BEGIN');
        if (orgId) await client.query("SELECT set_config('app.current_organization_id', $1, true)", [orgId]);
        const files = await client.query('SELECT id FROM files.files WHERE id = ANY($1)', [[fileA.id, fileB.id]]);
        const versions = await client.query('SELECT file_id FROM files.file_versions WHERE file_id = ANY($1)', [
          [fileA.id, fileB.id],
        ]);
        await client.query('ROLLBACK');
        return [files.rows.map((r: { id: string }) => r.id), versions.rows.map((r: { file_id: string }) => r.file_id)];
      });

    expect(await idsSeenBy(a.orgId)).toEqual([[fileA.id], [fileA.id]]);
    expect(await idsSeenBy(b.orgId)).toEqual([[fileB.id], [fileB.id]]);
    expect(await idsSeenBy(undefined)).toEqual([[], []]);
  });
});
