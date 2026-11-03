// Local-filesystem driver for development. Everything lives under one root directory that is never served.
// Uploads stream into <root>/.tmp and are renamed into place (same filesystem, so atomic); readers never see a
// partial object. A key is accepted only if it has the exact server-generated shape AND resolves inside the root.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline, Transform, type Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  StorageInterruptedError,
  StorageKeyError,
  StorageLimitError,
  StorageNotFoundError,
  StorageSizeMismatchError,
  type FileStorage,
  type StageLimits,
  type StagedObject,
} from './file-storage.js';

const pipe = promisify(pipeline);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp(`^${UUID}/${UUID}/[1-9][0-9]{0,8}$`);

export class LocalFileStorage implements FileStorage {
  private readonly root: string;
  private readonly tmp: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.tmp = path.join(this.root, '.tmp');
  }

  /** The absolute path of a key, or StorageKeyError. Exposed for the containment tests. */
  resolve(key: string): string {
    if (!KEY.test(key)) throw new StorageKeyError('invalid storage key');
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(this.root + path.sep)) throw new StorageKeyError('storage key escapes the root');
    return resolved;
  }

  async stage(source: Readable, limits: StageLimits): Promise<StagedObject> {
    await mkdir(this.tmp, { recursive: true, mode: 0o700 });
    const tempPath = path.join(this.tmp, randomUUID());
    const hash = createHash('sha256');
    let received = 0;
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length;
        if (received > limits.maxBytes || received > limits.expectedBytes) {
          callback(new StorageLimitError('upload exceeds the permitted size'));
          return;
        }
        hash.update(chunk);
        limits.observe?.(chunk);
        callback(null, chunk);
      },
    });
    // pipe(), not pipeline(), from the source: a refused upload must not destroy the request socket, so the
    // error response can still be delivered (Node drains the rest of the request after the response).
    source.pipe(counter);
    source.once('error', (error) => counter.destroy(error));
    source.once('close', () => {
      if (!source.readableEnded) counter.destroy(new StorageInterruptedError('upload interrupted'));
    });
    try {
      await pipe(counter, createWriteStream(tempPath, { flags: 'wx', mode: 0o600 }));
      if (received !== limits.expectedBytes) throw new StorageSizeMismatchError('upload shorter than declared');
    } catch (error) {
      source.unpipe(counter);
      await rm(tempPath, { force: true });
      throw error;
    }
    let done = false;
    return {
      sizeBytes: received,
      sha256: hash.digest('hex'),
      promote: async (key) => {
        const target = this.resolve(key);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await rename(tempPath, target);
        done = true;
      },
      discard: async () => {
        if (!done) await rm(tempPath, { force: true });
      },
    };
  }

  async get(key: string): Promise<{ stream: Readable; sizeBytes: number }> {
    const target = this.resolve(key);
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new StorageNotFoundError('object missing');
      return { stream: createReadStream(target), sizeBytes: info.size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StorageNotFoundError('object missing');
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async sweepStaging(olderThanMs: number): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.tmp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const name of names) {
      const file = path.join(this.tmp, name);
      try {
        const info = await stat(file);
        if (info.isFile() && Date.now() - info.mtimeMs > olderThanMs) {
          await rm(file, { force: true });
          removed++;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }
}
