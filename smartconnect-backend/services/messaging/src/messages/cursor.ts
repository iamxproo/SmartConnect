// Keyset cursor of the timeline order (created_at DESC, id DESC): the last row of the page, opaque to clients.
import { ApiProblemException } from '@smartconnect/backend-kit';
import { UUID_PATTERN } from '../common/uuid.js';

export interface TimelinePosition {
  createdAt: Date;
  id: string;
}

/** 9999-12-31T23:59:59.999Z: later instants do not survive the trip to PostgreSQL (years above 9999 are not ISO). */
const MAX_CURSOR_MS = 253_402_300_799_999;

export const encodeCursor = ({ createdAt, id }: TimelinePosition): string =>
  Buffer.from(`${createdAt.getTime()}.${id}`).toString('base64url');

const invalidCursor = () =>
  new ApiProblemException(422, 'validation_failed', '1 validation error', [
    { field: 'cursor', code: 'invalid_cursor', message: 'cursor is not a valid page cursor' },
  ]);

export function decodeCursor(cursor: string | undefined): TimelinePosition | undefined {
  if (cursor === undefined) return undefined;
  const match = /^(\d{1,15})\.([0-9a-f-]{36})$/i.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!match || !UUID_PATTERN.test(match[2]!) || Number(match[1]) > MAX_CURSOR_MS) throw invalidCursor();
  return { createdAt: new Date(Number(match[1])), id: match[2]!.toLowerCase() };
}
