import { describe, expect, it } from 'vitest';
import { ApiProblemException } from '@smartconnect/backend-kit';
import { decodeCursor, encodeCursor, paginate } from '../src/common/pagination.js';
import { hasPermission } from '../src/org/organization-directory.js';

describe('hasPermission', () => {
  it('grants everything for "*" and otherwise requires the exact key', () => {
    expect(hasPermission(['*'], 'workspaces.create')).toBe(true);
    expect(hasPermission(['workspaces.create'], 'workspaces.create')).toBe(true);
    expect(hasPermission(['teams.manage'], 'workspaces.create')).toBe(false);
    expect(hasPermission([], 'workspaces.create')).toBe(false);
    expect(hasPermission(['workspaces.*'], 'workspaces.create')).toBe(false);
  });
});

describe('pagination', () => {
  const id = '0195a8f0-1b2c-7d3e-8f40-123456789abc';

  it('round-trips cursors and rejects anything that is not a base64url uuid', () => {
    expect(decodeCursor(encodeCursor(id))).toBe(id);
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(() => decodeCursor(Buffer.from("x'; drop table").toString('base64url'))).toThrow(ApiProblemException);
  });

  it('trims the look-ahead row and derives nextCursor from the last returned id', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(paginate(rows, 2)).toEqual({ rows: [{ id: 'a' }, { id: 'b' }], nextCursor: encodeCursor('b') });
    expect(paginate(rows, 3)).toEqual({ rows, nextCursor: null });
  });
});
