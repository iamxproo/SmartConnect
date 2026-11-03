import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { MessageBaseDto } from '../messages/dto.js';

export const ROLES = ['admin', 'member'] as const;
export type Role = (typeof ROLES)[number];

export const MAX_PARTICIPANTS = 50;

const lowerCase = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.toLowerCase() : value);
const lowerCaseAll = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value) ? value.map((v) => lowerCase({ value: v })) : value;

const TITLE = { message: 'title must be 1 to 120 characters and not blank' };

export class DirectDto {
  @ApiProperty({ format: 'uuid' })
  @Transform(lowerCase)
  @IsUUID()
  userId!: string;
}

export class GroupDto {
  @ApiPropertyOptional({ type: String, nullable: true, minLength: 1, maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  @Matches(/\S/, TITLE)
  title?: string | null;

  @ApiProperty({ type: [String], minItems: 2, maxItems: MAX_PARTICIPANTS - 1, description: 'Distinct others' })
  @Transform(lowerCaseAll)
  @IsUUID(undefined, { each: true })
  @ArrayUnique()
  @ArrayMinSize(2)
  @ArrayMaxSize(MAX_PARTICIPANTS - 1)
  userIds!: string[];
}

export class RenameDto {
  @ApiProperty({ type: String, nullable: true, minLength: 1, maxLength: 120 })
  @ValidateIf((o: RenameDto) => o.title !== null)
  @IsString()
  @Length(1, 120)
  @Matches(/\S/, TITLE)
  title!: string | null;
}

export class ParticipantRoleDto {
  @ApiPropertyOptional({ enum: ROLES })
  @IsOptional()
  @IsIn(ROLES)
  role?: Role;
}

export class ReadDto {
  @ApiProperty({ format: 'uuid' })
  @Transform(lowerCase)
  @IsUUID()
  messageId!: string;
}

export class ParticipantDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ enum: ROLES }) role!: Role;
  @ApiProperty({ format: 'date-time' }) joinedAt!: string;
}

export class ConversationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['direct', 'group'] }) kind!: 'direct' | 'group';
  @ApiProperty({ type: String, nullable: true }) title!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) createdByUserId!: string | null;
  @ApiProperty({ type: [ParticipantDto] }) participants!: ParticipantDto[];
  @ApiProperty({ enum: ROLES }) myRole!: Role;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastMessageAt!: string | null;
  @ApiProperty({ format: 'date-time' }) lastActivityAt!: string;
  @ApiProperty({ minimum: 0, maximum: 100, description: 'Capped at 100' }) unreadCount!: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) lastReadMessageId!: string | null;
}

export class ConversationListDto {
  @ApiProperty({ type: [ConversationDto] }) data!: ConversationDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class ConversationMessageDto extends MessageBaseDto {
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
}

export class ConversationMessageListDto {
  @ApiProperty({ type: [ConversationMessageDto] }) data!: ConversationMessageDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ minimum: 0, maximum: 100, description: "The caller's unread messages, capped at 100" })
  unreadCount!: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) lastReadMessageId!: string | null;
}

export class ConversationRepliesListDto {
  @ApiProperty({ type: [ConversationMessageDto] }) data!: ConversationMessageDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class InboxDto {
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
}

export class ConversationContextDto {
  @ApiProperty({ type: [ConversationMessageDto], description: 'Older messages, the target, newer: oldest first' })
  data!: ConversationMessageDto[];
  @ApiProperty({ format: 'uuid', description: 'The timeline message to highlight (the thread root for a reply)' })
  targetId!: string;
  @ApiProperty({ description: "The requested message is a thread reply: the context is its root's" })
  isReply!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'The requested reply, when isReply' })
  replyId!: string | null;
}
