import { randomBytes } from 'node:crypto';

/**
 * RFC 9562 UUIDv7 (time-ordered, like the schema's `uuid(7)` defaults). Needed where the id must be known before the
 * insert: a new organization's id is also the tenant context its own rows are written under.
 */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Keyset cursors: base64url of the last id on the page (opaque to clients). */
export const encodeCursor = (id: string) => Buffer.from(id).toString('base64url');
export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id) ? id : undefined;
}
