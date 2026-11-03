import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  StorageKeyError,
  StorageLimitError,
  StorageNotFoundError,
  StorageSizeMismatchError,
  storageKeyOf,
} from '../src/storage/file-storage.js';
import { LocalFileStorage } from '../src/storage/local-file-storage.js';

const ORG = '019a4a00-0000-7000-8000-000000000001';
const FILE = '019a4a00-0000-7000-8000-000000000002';
const KEY = storageKeyOf(ORG, FILE, 1);

let root: string;
let storage: LocalFileStorage;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'files-storage-'));
  storage = new LocalFileStorage(root);
});
afterEach(() => rm(root, { recursive: true, force: true }));

const chunks = (...parts: string[]) => Readable.from(parts.map((part) => Buffer.from(part)));
const read = async (key: string) => {
  const { stream } = await storage.get(key);
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts).toString();
};
const tempFiles = () => readdir(path.join(root, '.tmp')).catch(() => []);

describe('LocalFileStorage', () => {
  it('stages, counts and hashes a stream, then promotes it atomically under the key', async () => {
    const seen: string[] = [];
    const staged = await storage.stage(chunks('hello ', 'world'), {
      maxBytes: 100,
      expectedBytes: 11,
      observe: (chunk) => seen.push(chunk.toString()),
    });
    expect(staged.sizeBytes).toBe(11);
    expect(staged.sha256).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    expect(seen.join('')).toBe('hello world');
    await expect(storage.get(KEY)).rejects.toBeInstanceOf(StorageNotFoundError); // not readable before promote
    await staged.promote(KEY);
    expect(await read(KEY)).toBe('hello world');
    expect(await tempFiles()).toEqual([]);
    await staged.discard(); // after promote: a no-op
    expect(await read(KEY)).toBe('hello world');
  });

  it('aborts as soon as more than the maximum or the declared size arrives, leaving nothing behind', async () => {
    await expect(storage.stage(chunks('abcdef', 'ghijkl'), { maxBytes: 8, expectedBytes: 12 })).rejects.toBeInstanceOf(
      StorageLimitError,
    );
    await expect(storage.stage(chunks('abcdef', 'ghijkl'), { maxBytes: 100, expectedBytes: 8 })).rejects.toBeInstanceOf(
      StorageLimitError,
    );
    expect(await tempFiles()).toEqual([]);
  });

  it('refuses fewer bytes than declared', async () => {
    await expect(storage.stage(chunks('abc'), { maxBytes: 100, expectedBytes: 10 })).rejects.toBeInstanceOf(
      StorageSizeMismatchError,
    );
    expect(await tempFiles()).toEqual([]);
  });

  it('discards a staged object, and delete() tolerates missing objects', async () => {
    const staged = await storage.stage(chunks('abc'), { maxBytes: 100, expectedBytes: 3 });
    await staged.discard();
    expect(await tempFiles()).toEqual([]);
    const kept = await storage.stage(chunks('abc'), { maxBytes: 100, expectedBytes: 3 });
    await kept.promote(KEY);
    await storage.delete(KEY);
    await storage.delete(KEY);
    await expect(storage.get(KEY)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it('accepts only server-shaped keys and keeps every path inside the root', async () => {
    const hostile = [
      '../../etc/passwd',
      `${ORG}/${FILE}/../../../x`,
      `${ORG}/${FILE}/1/../../../..`,
      `/${ORG}/${FILE}/1`,
      `${ORG}/${FILE}/1/`,
      `${ORG}/${FILE}/01`,
      `${ORG}/${FILE}/0`,
      `${ORG}/${FILE}`,
      `${ORG}\\${FILE}\\1`,
      `${ORG}/${FILE}/1\0`,
      `${ORG}/..%2f${FILE}/1`,
      '',
      '.',
      '..',
    ];
    for (const key of hostile) {
      expect(() => storage.resolve(key), key).toThrow(StorageKeyError);
      await expect(storage.get(key)).rejects.toBeInstanceOf(StorageKeyError);
      await expect(storage.delete(key)).rejects.toBeInstanceOf(StorageKeyError);
    }
    expect(storage.resolve(KEY)).toBe(path.join(root, ORG, FILE, '1'));
  });

  it('does not follow a directory (a key that names a directory is not a file)', async () => {
    await mkdir(path.join(root, ORG, FILE, '1'), { recursive: true });
    await expect(storage.get(KEY)).rejects.toBeInstanceOf(StorageNotFoundError);
  });

  it('keeps a pre-planted outside file unreachable by any key', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'files-outside-'));
    try {
      await writeFile(path.join(outside, 'secret'), 'secret');
      await mkdir(path.join(root, ORG), { recursive: true });
      await symlink(outside, path.join(root, ORG, FILE));
      // A symlink can only be planted by someone with write access to the storage directory; keys never name one.
      expect(() => storage.resolve('../' + path.basename(outside) + '/secret')).toThrow(StorageKeyError);
      expect(await readFile(path.join(outside, 'secret'), 'utf8')).toBe('secret');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('sweepStaging', () => {
  it('removes only staged leftovers older than the age, and tolerates a missing staging directory', async () => {
    expect(await storage.sweepStaging(1000)).toBe(0); // nothing staged yet: no .tmp directory
    await mkdir(path.join(root, '.tmp'), { recursive: true });
    const old = path.join(root, '.tmp', 'orphan');
    const fresh = path.join(root, '.tmp', 'live');
    await writeFile(old, 'x');
    await writeFile(fresh, 'y');
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(old, longAgo, longAgo);
    expect(await storage.sweepStaging(60 * 60 * 1000)).toBe(1);
    expect(await readdir(path.join(root, '.tmp'))).toEqual(['live']);
  });
});
