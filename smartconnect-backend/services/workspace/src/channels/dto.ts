// `type` is required on create: no silent default to public.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDefined, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PageInfoDto } from '../common/pagination.js';

const Trim = () => Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));
const Lowercase = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));

export const channelTypes = ['public', 'private'] as const;
export const channelRoles = ['admin', 'member'] as const;
export type ChannelTypeValue = (typeof channelTypes)[number];
export type ChannelRoleValue = (typeof channelRoles)[number];

export const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export class CreateChannelDto {
  @ApiProperty({ maxLength: 80, pattern: CHANNEL_NAME_PATTERN.source, description: 'Lowercased; unique per workspace' })
  @Lowercase()
  @IsString()
  @Matches(CHANNEL_NAME_PATTERN, {
    message: 'name must be lowercase letters, digits, hyphens and underscores (1 to 80 characters)',
  })
  name!: string;

  @ApiPropertyOptional({ maxLength: 250 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(250)
  topic?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ enum: channelTypes, description: 'Required: "public" (any workspace member) or "private"' })
  @IsDefined()
  @IsIn(channelTypes)
  type!: ChannelTypeValue;
}

export class PutChannelMemberDto {
  @ApiPropertyOptional({ enum: channelRoles, description: 'Defaults to "member" for new members' })
  @IsOptional()
  @IsIn(channelRoles)
  role?: ChannelRoleValue;
}

export class ChannelDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) workspaceId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) topic!: string | null;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ enum: channelTypes }) type!: ChannelTypeValue;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() isMember!: boolean;
  @ApiProperty({ enum: channelRoles, nullable: true }) myRole!: ChannelRoleValue | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) archivedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class ChannelListDto extends PageInfoDto {
  @ApiProperty({ type: [ChannelDto] }) data!: ChannelDto[];
}

export class ChannelSearchResultDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) workspaceId!: string;
  @ApiProperty() workspaceName!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: channelTypes }) type!: ChannelTypeValue;
  @ApiProperty() isMember!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) archivedAt!: string | null;
}

export class ChannelSearchListDto extends PageInfoDto {
  @ApiProperty({ type: [ChannelSearchResultDto] }) data!: ChannelSearchResultDto[];
}

export class ChannelMemberDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ enum: channelRoles }) role!: ChannelRoleValue;
  @ApiProperty({ format: 'date-time' }) joinedAt!: string;
}

export class ChannelMemberListDto extends PageInfoDto {
  @ApiProperty({ type: [ChannelMemberDto] }) data!: ChannelMemberDto[];
}
