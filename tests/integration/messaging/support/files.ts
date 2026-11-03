// A FAKE files service for the attachment suites: `GET /api/v1/orgs/{o}/files/{id}` answers from an in-memory table
// behind an ephemeral http server, and records who asked (the caller's own token must be forwarded).
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startCollab, type Collab } from './collab.js';

const subjectOf = (authorization: string | undefined): string | undefined => {
  const payload = authorization?.split(' ')[1]?.split('.')[1];
  return payload ? (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub: string }).sub : undefined;
};

export interface FakeFile {
  orgId: string;
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  status: 'pending_upload' | 'available' | 'deleted';
  uploadedByUserId: string;
}

export class FakeFilesService {
  private readonly files = new Map<string, FakeFile>();
  /** Answer every request with a 500. */
  failing = false;
  readonly requests: { url: string; caller: string | undefined }[] = [];
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeFilesService> {
    const holder: { fake?: FakeFilesService } = {};
    const server = createServer((req, res) => {
      const fake = holder.fake!;
      const caller = subjectOf(req.headers.authorization);
      fake.requests.push({ url: req.url ?? '', caller });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (fake.failing) return send(500, { code: 'internal' });
      const match = /^\/api\/v1\/orgs\/([^/]+)\/files\/([^/]+)$/.exec(req.url ?? '');
      const file = match && fake.files.get(`${match[1]}|${match[2]}`);
      if (!caller || !file || file.status === 'deleted') return send(404, { code: 'not_found' });
      return send(200, {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        status: file.status,
        uploadedByUserId: file.uploadedByUserId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const fake = new FakeFilesService(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    holder.fake = fake;
    return fake;
  }

  add(orgId: string, uploadedByUserId: string, overrides: Partial<FakeFile> = {}): string {
    const file: FakeFile = {
      orgId,
      id: randomUUID(),
      name: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      status: 'available',
      uploadedByUserId,
      ...overrides,
    };
    this.files.set(`${orgId}|${file.id}`, file);
    return file.id;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }
}

export interface FilesCollab extends Collab {
  files: FakeFilesService;
}

export async function startCollabWithFiles(): Promise<FilesCollab> {
  const files = await FakeFilesService.start();
  const collab = await startCollab({ FILES_SERVICE_URL: files.url });
  return {
    ...collab,
    files,
    close: async () => {
      await collab.close();
      await files.close();
    },
  };
}
