// Request and response contracts of the workspace endpoints (docs/api/endpoints.md#workspaces-and-channels).
// `visibility` is required on create: no silent default to open.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDefined, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PageInfoDto } from '../common/pagination.js';

const Trim = () => Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

export const workspaceVisibilities = ['open', 'private'] as const;
export const workspaceRoles = ['admin', 'member', 'guest'] as const;
export type WorkspaceVisibilityValue = (typeof workspaceVisibilities)[number];
export type WorkspaceRoleValue = (typeof workspaceRoles)[number];

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class CreateWorkspaceDto {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ maxLength: 63, pattern: SLUG_PATTERN.source, description: 'Unique per organization' })
  @Trim()
  @IsString()
  @Matches(SLUG_PATTERN, { message: 'slug must be lowercase letters, digits and hyphens (1 to 63 characters)' })
  slug!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ enum: workspaceVisibilities, description: 'Required: "open" (any member may join) or "private"' })
  @IsDefined()
  @IsIn(workspaceVisibilities)
  visibility!: WorkspaceVisibilityValue;
}

export class UpdateWorkspaceDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 80 })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true, description: 'null clears the description' })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ enum: workspaceVisibilities })
  @IsOptional()
  @IsIn(workspaceVisibilities)
  visibility?: WorkspaceVisibilityValue;
}

export class PutWorkspaceMemberDto {
  @ApiProperty({ enum: workspaceRoles })
  @IsDefined()
  @IsIn(workspaceRoles)
  role!: WorkspaceRoleValue;
}

export class WorkspaceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: workspaceVisibilities }) visibility!: WorkspaceVisibilityValue;
  @ApiProperty({ enum: workspaceRoles, nullable: true, description: "The caller's role; null when not a member" })
  myRole!: WorkspaceRoleValue | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) archivedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class WorkspaceListDto extends PageInfoDto {
  @ApiProperty({ type: [WorkspaceDto] }) data!: WorkspaceDto[];
}

export class WorkspaceMemberDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ enum: workspaceRoles }) role!: WorkspaceRoleValue;
  @ApiProperty({ format: 'date-time' }) joinedAt!: string;
}

export class WorkspaceMemberListDto extends PageInfoDto {
  @ApiProperty({ type: [WorkspaceMemberDto] }) data!: WorkspaceMemberDto[];
}
