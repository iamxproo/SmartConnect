// Local-filesystem driver for development and tests (and the default outside production). Everything lives under one
// root directory that is never served. Uploads stream into <root>/.tmp and are renamed into place (same filesystem,
// so atomic); readers never see a partial object. A key is accepted only if it has the exact server-generated shape
// AND resolves inside the root.
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import {
  assertStorageKey,
  StorageKeyError,
  StorageNotFoundError,
  type FileStorage,
  type StageLimits,
  type StagedObject,
} from './file-storage.js';
import { stageToFile, sweepDirectory } from './staging.js';

export class LocalFileStorage implements FileStorage {
  readonly provider = 'local';
  private readonly root: string;
  private readonly tmp: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.tmp = path.join(this.root, '.tmp');
  }

  /** The absolute path of a key, or StorageKeyError. Exposed for the containment tests. */
  resolve(key: string): string {
    const resolved = path.resolve(this.root, assertStorageKey(key));
    if (!resolved.startsWith(this.root + path.sep)) throw new StorageKeyError('storage key escapes the root');
    return resolved;
  }

  async stage(source: Readable, limits: StageLimits): Promise<StagedObject> {
    const staged = await stageToFile(this.tmp, source, limits);
    let done = false;
    return {
      sizeBytes: staged.sizeBytes,
      sha256: staged.sha256,
      promote: async (key) => {
        const target = this.resolve(key);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await rename(staged.path, target);
        done = true;
      },
      discard: async () => {
        if (!done) await rm(staged.path, { force: true });
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

  async head(key: string): Promise<{ sizeBytes: number } | undefined> {
    try {
      const info = await stat(this.resolve(key));
      return info.isFile() ? { sizeBytes: info.size } : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  /** Every object file under the root (staged uploads in .tmp are not objects yet). */
  async usage(): Promise<{ bytes: number; objects: number }> {
    let bytes = 0;
    let objects = 0;
    let entries;
    try {
      entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: 0, objects: 0 };
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (file.startsWith(this.tmp + path.sep)) continue;
      try {
        bytes += (await stat(file)).size;
        objects += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return { bytes, objects };
  }

  sweepStaging(olderThanMs: number): Promise<number> {
    return sweepDirectory(this.tmp, olderThanMs);
  }
}
