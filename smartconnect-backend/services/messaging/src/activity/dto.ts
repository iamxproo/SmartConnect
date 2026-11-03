import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, Matches } from 'class-validator';
import { PageQueryDto } from '../messages/dto.js';

export const ACTIVITY_FILTERS = ['all', 'unread', 'mentions', 'threads'] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export class ActivityQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ACTIVITY_FILTERS, default: 'all' })
  @IsOptional()
  @IsIn(ACTIVITY_FILTERS)
  filter?: ActivityFilter;
}

export class ActivityMessageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) senderUserId!: string | null;
  @ApiProperty({
    maxLength: 200,
    description: 'Plain text, at most 200 characters. Mentions stay as `<@userId>` tokens for the client to resolve.',
  })
  excerpt!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) threadRootId!: string | null;
}

export class ActivityLocationDto {
  @ApiProperty({ enum: ['channel', 'direct', 'group'] }) kind!: 'channel' | 'direct' | 'group';
  @ApiPropertyOptional({ format: 'uuid', description: 'Channels only' }) workspaceId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Channels only' }) channelId?: string;
  @ApiPropertyOptional({ format: 'uuid', description: 'Direct and group conversations only' }) conversationId?: string;
}

export class ActivityItemDto {
  @ApiProperty({ description: '"<kind>:<messageId>"' }) id!: string;
  @ApiProperty({ enum: ['mention', 'thread_reply'] }) kind!: 'mention' | 'thread_reply';
  @ApiProperty({ type: ActivityMessageDto }) message!: ActivityMessageDto;
  @ApiProperty({ type: ActivityLocationDto }) location!: ActivityLocationDto;
  @ApiProperty() unread!: boolean;
}

export class ActivityListDto {
  @ApiProperty({ type: [ActivityItemDto] }) data!: ActivityItemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class UnreadCountDto {
  @ApiProperty({ minimum: 0, maximum: 100, description: 'Capped at 100' }) count!: number;
}

export class ReadItemsDto {
  @ApiProperty({ type: [String], description: '"<kind>:<messageId>" ids, at most 100' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @Matches(/^(mention|thread_reply):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { each: true })
  itemIds!: string[];
}
