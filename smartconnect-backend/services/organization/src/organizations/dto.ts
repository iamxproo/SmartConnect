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

export class CreateOrganizationDto {
  @ApiProperty({ maxLength: 120, example: 'Acme Corporation' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ pattern: SLUG.source, example: 'acme' })
  @IsString()
  @Matches(SLUG, { message: 'slug must be 1-63 lowercase letters, digits or inner hyphens' })
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
