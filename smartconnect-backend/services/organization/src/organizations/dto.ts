import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/** Same rule as the organizations_slug_format_chk constraint. */
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A new organization's handle: SLUG, and not shaped like an id. Web addresses take a handle or an id
 * (/o/{handleOrId}), so a handle must never read as another organization's id.
 */
export const ORGANIZATION_SLUG = new RegExp(
  `^(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$)${SLUG.source.slice(1)}`,
);

/**
 * An organization's display name: at least one letter or digit, and no control or text-direction override characters
 * (which could make a name in an invitation or a list read as something else).
 */
export const ORGANIZATION_NAME = /^(?=.*[\p{L}\p{N}])[^\p{Cc}\u202A-\u202E\u2066-\u2069]*$/u;
const NAME_MESSAGE = 'name must contain a letter or digit, and no control or text-direction characters';

export class CreateOrganizationDto {
  @ApiProperty({ maxLength: 120, example: 'Acme Corporation' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(ORGANIZATION_NAME, { message: NAME_MESSAGE })
  name!: string;

  @ApiProperty({ pattern: ORGANIZATION_SLUG.source, example: 'acme' })
  @IsString()
  @Matches(ORGANIZATION_SLUG, {
    message: 'slug must be 1-63 lowercase letters, digits or inner hyphens, and not shaped like an id',
  })
  slug!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class OrganizationSettingsDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 30, description: 'Days until a new invitation expires' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  invitationExpiryDays?: number;
}

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(ORGANIZATION_NAME, { message: NAME_MESSAGE })
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ type: OrganizationSettingsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OrganizationSettingsDto)
  settings?: OrganizationSettingsDto;
}

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

export const MAX_MEMBER_LOOKUP = 100;

export class ListMembersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: `Only the memberships of these users (if any). Repeat the parameter for several, at most ${MAX_MEMBER_LOOKUP}`,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (Array.isArray(value) ? (value as unknown[]) : [value]))
  @IsArray()
  @ArrayMaxSize(MAX_MEMBER_LOOKUP)
  @IsUUID(undefined, { each: true })
  userId?: string[];

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 100,
    description: 'Case-insensitive match on display name or email (substring). Combines with the other filters',
  })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  q?: string;
}

export class UpdateMemberDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  roleId?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 120 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @Trim()
  @IsString()
  @MaxLength(120)
  title?: string | null;
}
