import { describe, expect, it } from 'vitest';
import { UUID_PATTERN, uuidv7 } from '../src/common/uuid.js';
import { decodeCursor, encodeCursor } from '../src/messages/cursor.js';

const id = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('timeline cursor', () => {
  it('round-trips (createdAt, id) with millisecond precision', () => {
    const position = { createdAt: new Date('2026-11-03T10:20:30.123Z'), id };
    const cursor = encodeCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(position);
  });

  it('accepts the last millisecond of year 9999 and the epoch', () => {
    for (const ms of [253_402_300_799_999, 0]) {
      const position = { createdAt: new Date(ms), id };
      expect(decodeCursor(encodeCursor(position))).toEqual(position);
    }
  });

  it('is absent when no cursor is given', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it.each([
    ['not base64 of a position', 'aGVsbG8'],
    ['empty', ''],
    ['bad id', Buffer.from('1700000000000.not-a-uuid-not-a-uuid-not-a-uuid-xx').toString('base64url')],
    [
      'year 33658 (15 digits, past what PostgreSQL accepts as ISO)',
      Buffer.from(`999999999999999.${id}`).toString('base64url'),
    ],
    ['one millisecond past 9999-12-31', Buffer.from(`253402300800000.${id}`).toString('base64url')],
    ['sql-ish', Buffer.from(`1; drop table messages.${id}`).toString('base64url')],
  ])('rejects a tampered cursor: %s', (_name, cursor) => {
    expect(() => decodeCursor(cursor)).toThrowError(expect.objectContaining({ status: 422 }) as Error);
  });
});

describe('uuidv7', () => {
  it('is a version 7 UUID that sorts by creation time', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(UUID_PATTERN);
    expect(a[14]).toBe('7');
    expect('89ab').toContain(a[19]);
    expect(a < b).toBe(true);
  });
});
