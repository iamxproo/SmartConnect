import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';
import { MessageBaseDto } from '../messages/dto.js';

const lowerCase = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.toLowerCase() : value);
// eslint-disable-next-line no-control-regex
const NO_NUL = /^[^\u0000]*$/;

export class SearchQueryDto {
  @ApiProperty({ minLength: 1, maxLength: 200, description: 'websearch syntax: "phrase", -exclude, or' })
  @IsString()
  @Length(1, 200)
  @Matches(/\S/, { message: 'q must not be blank' })
  @Matches(NO_NUL, { message: 'q must not contain NUL characters' })
  q!: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only messages from this sender' })
  @IsOptional()
  @Transform(lowerCase)
  @IsUUID()
  from?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only this channel (not with conversationId)' })
  @IsOptional()
  @Transform(lowerCase)
  @IsUUID()
  channelId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Only this direct or group conversation' })
  @IsOptional()
  @Transform(lowerCase)
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Created before this instant (exclusive)' })
  @IsOptional()
  @IsISO8601({ strict: true })
  before?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Created at or after this instant' })
  @IsOptional()
  @IsISO8601({ strict: true })
  after?: string;

  @ApiPropertyOptional({ enum: ['file'], description: 'Only messages with an attachment' })
  @IsOptional()
  @IsIn(['file'])
  has?: 'file';

  @ApiPropertyOptional({ enum: ['messages', 'files'], default: 'messages' })
  @IsOptional()
  @IsIn(['messages', 'files'])
  type?: 'messages' | 'files';

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page (nextCursor)' })
  @IsOptional()
  @IsString()
  @Length(1, 128)
  cursor?: string;
}

export class SearchLocationDto {
  @ApiProperty({ enum: ['channel', 'direct', 'group'] }) kind!: 'channel' | 'direct' | 'group';
  @ApiPropertyOptional({ format: 'uuid', description: 'channel only' }) workspaceId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'channel only' }) channelId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'direct and group only' }) conversationId?: string;
}

export class SearchAttachmentDto {
  @ApiProperty({ format: 'uuid' }) fileId!: string;
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true }) mimeType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) sizeBytes!: number | null;
}

export class MessageHitDto extends MessageBaseDto {
  @ApiProperty({ type: SearchLocationDto }) location!: SearchLocationDto;
}

export class FileHitDto extends SearchAttachmentDto {
  @ApiProperty({ format: 'uuid' }) messageId!: string;
  @ApiProperty({ type: SearchLocationDto }) location!: SearchLocationDto;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class MessageSearchDto {
  @ApiProperty({ type: [MessageHitDto] }) data!: MessageHitDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class FileSearchDto {
  @ApiProperty({ type: [FileHitDto] }) data!: FileHitDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export type SearchLocation = {
  kind: 'channel' | 'direct' | 'group';
  workspaceId?: string;
  channelId?: string;
  conversationId?: string;
};
