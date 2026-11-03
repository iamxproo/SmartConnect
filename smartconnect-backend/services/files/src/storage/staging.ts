// Staging, shared by every driver: an upload streams into a private temporary file while it is counted, checked
// against the limits and hashed, so nothing becomes readable (or is sent to object storage) until every byte has
// arrived and matched the declaration. The local driver then renames the file into place; the R2 driver uploads it
// with its SHA-256, which the provider verifies.
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline, Transform, type Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  StorageInterruptedError,
  StorageLimitError,
  StorageSizeMismatchError,
  type StageLimits,
} from './file-storage.js';

const pipe = promisify(pipeline);

export interface StagedFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

/** Streams `source` into a new file in `dir` under the limits; leaves nothing behind when it rejects. */
export async function stageToFile(dir: string, source: Readable, limits: StageLimits): Promise<StagedFile> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, randomUUID());
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
  return { path: tempPath, sizeBytes: received, sha256: hash.digest('hex') };
}

/** Removes files in `dir` older than `olderThanMs`; a missing directory is empty. Returns how many were removed. */
export async function sweepDirectory(dir: string, olderThanMs: number): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
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
