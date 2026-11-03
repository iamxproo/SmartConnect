import { ApiProperty } from '@nestjs/swagger';
import { MessageBaseDto } from '../messages/dto.js';

export class SavedMessageDto extends MessageBaseDto {
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty({ enum: ['channel', 'direct', 'group'] }) kind!: 'channel' | 'direct' | 'group';
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) channelId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) workspaceId!: string | null;
  @ApiProperty({ format: 'date-time' }) savedAt!: string;
}

export class SavedMessageListDto {
  @ApiProperty({ type: [SavedMessageDto] }) data!: SavedMessageDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
