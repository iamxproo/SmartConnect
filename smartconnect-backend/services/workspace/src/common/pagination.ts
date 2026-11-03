import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ApiProblemException } from '@smartconnect/backend-kit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class PageQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page (nextCursor)' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  cursor?: string;
}

export class PageInfoDto {
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}

/** Cursor = base64url of the last id on the page; ids are UUIDv7, so id order is creation order (keyset). */
export const encodeCursor = (id: string) => Buffer.from(id).toString('base64url');

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!UUID.test(id)) {
    throw new ApiProblemException(422, 'validation_failed', '1 validation error', [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is not a valid page cursor' },
    ]);
  }
  return id;
}

export interface Page {
  take: number;
  afterId: string | undefined;
}

export function pageOf(query: PageQueryDto): Page {
  return { take: query.limit ?? 50, afterId: decodeCursor(query.cursor) };
}

/** Rows fetched with `take + 1`: trims the extra row and derives nextCursor. */
export function paginate<T extends { id: string }>(rows: T[], take: number): { rows: T[]; nextCursor: string | null } {
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return { rows: page, nextCursor: hasMore ? encodeCursor(page[page.length - 1]!.id) : null };
}
