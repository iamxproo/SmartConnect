import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Max,
  Min,
  ValidateIf,
  registerDecorator,
} from 'class-validator';

export const MAX_BODY_LENGTH = 40_000;

// eslint-disable-next-line no-control-regex
const NO_NUL = /^[^\u0000]*$/;

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
  @MaxLength(128)
  cursor?: string;
}

export class EditMessageDto {
  @ApiProperty({ minLength: 1, maxLength: MAX_BODY_LENGTH, description: 'Markdown; must not be blank' })
  @IsString()
  @MaxLength(MAX_BODY_LENGTH)
  @Matches(/\S/, { message: 'body must not be blank' })
  @Matches(NO_NUL, { message: 'body must not contain NUL characters' })
  body!: string;
}

export const MAX_ATTACHMENTS = 10;

const hasAttachments = (o: { attachmentFileIds?: unknown }): boolean =>
  Array.isArray(o.attachmentFileIds) && o.attachmentFileIds.length > 0;

/** The body must contain a non-space character, unless the message carries attachments. */
function NotBlankUnlessAttached() {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: 'notBlankUnlessAttached',
      target: target.constructor,
      propertyName,
      options: { message: 'body must not be blank' },
      validator: {
        validate: (value: unknown, args) =>
          typeof value === 'string' &&
          (/\S/.test(value) || hasAttachments(args?.object as { attachmentFileIds?: unknown })),
      },
    });
}

export class PostMessageDto {
  @ApiPropertyOptional({
    maxLength: MAX_BODY_LENGTH,
    description: 'Markdown; must not be blank unless the message has attachments (then it may be empty or omitted)',
  })
  @ValidateIf((o: PostMessageDto) => o.body !== undefined || !hasAttachments(o))
  @IsString()
  @MaxLength(MAX_BODY_LENGTH)
  @NotBlankUnlessAttached()
  @Matches(NO_NUL, { message: 'body must not contain NUL characters' })
  body?: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_ATTACHMENTS,
    description: 'Distinct ids of your own available files, in display order',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value) ? value.map((v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v)) : value,
  )
  @IsArray()
  @ArrayMaxSize(MAX_ATTACHMENTS)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  attachmentFileIds?: string[];

  @ApiPropertyOptional({ maxLength: 64, pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Idempotency key per sender' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'clientMessageId must be 1 to 64 letters, digits, "-" or "_"' })
  clientMessageId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Post as a reply in the thread of this top-level message' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID()
  threadRootId?: string;
}

export class ContextQueryDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 25, default: 10, description: 'Older messages' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(25)
  before?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 25, default: 10, description: 'Newer messages' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(25)
  after?: number;
}

export class ReadMessageDto {
  @ApiProperty({ format: 'uuid' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID()
  messageId!: string;
}

export class AttachmentDto {
  @ApiProperty({ format: 'uuid' }) fileId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
}

export class ThreadSummaryDto {
  @ApiProperty({ minimum: 1 }) replyCount!: number;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastReplyAt!: string | null;
  @ApiProperty({ type: [String], description: 'The first repliers (at most 20)' }) participantUserIds!: string[];
}

export class ReactionDto {
  @ApiProperty({ description: 'One Unicode emoji sequence' }) emoji!: string;
  @ApiProperty({ minimum: 1 }) count!: number;
  @ApiProperty({ description: 'The caller has reacted with this emoji' }) reacted!: boolean;
}

/** The fields channel and conversation messages share. */
export class MessageBaseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) senderUserId!: string | null;
  @ApiProperty({ enum: ['standard', 'system'] }) type!: 'standard' | 'system';
  @ApiProperty({ type: String, nullable: true, description: 'null once the message is deleted (content is erased)' })
  body!: string | null;
  @ApiProperty({ type: String, nullable: true }) clientMessageId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'Set on thread replies' })
  threadRootId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) editedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) deletedAt!: string | null;
  @ApiProperty({ type: ThreadSummaryDto, nullable: true, description: 'On a root message with replies' })
  thread!: ThreadSummaryDto | null;
  @ApiProperty({ type: [ReactionDto] }) reactions!: ReactionDto[];
  @ApiProperty({ type: [String], description: 'Users mentioned with <@uuid> in the body' }) mentionedUserIds!: string[];
  @ApiProperty({ description: 'The caller saved this message' }) bookmarked!: boolean;
  @ApiProperty({ type: [AttachmentDto], description: 'Files attached to the message, in order' })
  attachments!: AttachmentDto[];
}

export class MessageDto extends MessageBaseDto {
  @ApiProperty({ format: 'uuid' }) channelId!: string;
}

export class MessageListDto {
  @ApiProperty({ type: [MessageDto] }) data!: MessageDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ minimum: 0, maximum: 100, description: "The caller's unread messages, capped at 100" })
  unreadCount!: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) lastReadMessageId!: string | null;
}

export class ContextDto {
  @ApiProperty({ type: [MessageDto], description: 'Older messages, the target, newer messages: oldest first' })
  data!: MessageDto[];
  @ApiProperty({ format: 'uuid', description: 'The timeline message to highlight (the thread root for a reply)' })
  targetId!: string;
  @ApiProperty({ description: "The requested message is a thread reply: the context is its root's" })
  isReply!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true, description: 'The requested reply, when isReply' })
  replyId!: string | null;
}

export class RepliesListDto {
  @ApiProperty({ type: [MessageDto] }) data!: MessageDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
