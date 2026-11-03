import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PageQueryDto } from './pagination.js';

/** Prisma's `contains` does not escape LIKE wildcards: `%`, `_` and the escape character itself must match literally. */
export const escapeLike = (text: string) => text.replace(/[\\%_]/g, '\\$&');

/** Page query with an optional name search. */
export class SearchPageQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 100,
    description: 'Case-insensitive substring of the name, within what the caller can already see',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  q?: string;
}

export const nameMatches = (q: string | undefined) =>
  q ? { name: { contains: escapeLike(q), mode: 'insensitive' as const } } : {};
