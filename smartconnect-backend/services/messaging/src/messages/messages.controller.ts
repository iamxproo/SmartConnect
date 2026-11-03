import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, type Principal } from '@smartconnect/backend-kit';
import type { Request, Response } from 'express';
import { CurrentChannel } from '../access/access.guard.js';
import type { ChannelAccess } from '../channels/channel-directory.js';
import { UuidParam } from '../common/uuid-param.js';
import {
  ContextDto,
  ContextQueryDto,
  EditMessageDto,
  MessageDto,
  MessageListDto,
  PageQueryDto,
  PostMessageDto,
  ReadMessageDto,
  RepliesListDto,
} from './dto.js';
import { MessagesService } from './messages.service.js';

const actorOf = (channel: ChannelAccess, principal: Principal) => ({
  organizationId: channel.organizationId,
  userId: principal.userId.toLowerCase(),
});

/** Every route is protected: AccessTokenGuard authenticates, ChannelAccessGuard asks the workspace service. */
@ApiTags('Messages')
@ApiBearerAuth(BEARER_AUTH)
@Controller('orgs/:orgId/workspaces/:workspaceId/channels/:channelId/messages')
export class MessagesController {
  constructor(@Inject(MessagesService) private readonly messages: MessagesService) {}

  @Get()
  @ApiOperation({ summary: 'Messages of a visible channel, newest first' })
  @ApiOkResponse({ type: MessageListDto })
  @ApiProblemResponses(401, 404, 422, 503)
  list(
    @CurrentChannel() channel: ChannelAccess,
    @CurrentPrincipal() principal: Principal,
    @Query() query: PageQueryDto,
  ): Promise<MessageListDto> {
    return this.messages.list(actorOf(channel, principal), channel, query.limit ?? 50, query.cursor);
  }

  @Post()
  @ApiOperation({
    summary:
      'Post a message or, with threadRootId, a thread reply (channel members). A repeated clientMessageId returns the original (200)',
  })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiOkResponse({ type: MessageDto, description: 'clientMessageId was already used: the original message' })
  @ApiProblemResponses(401, 403, 404, 409, 422, 503)
  async post(
    @CurrentChannel() channel: ChannelAccess,
    @CurrentPrincipal() principal: Principal,
    @Body() dto: PostMessageDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const { message, created } = await this.messages.post(
      actorOf(channel, principal),
      channel,
      { ...dto, body: dto.body ?? '' },
      req,
    );
    res.status(created ? 201 : 200);
    res.setHeader(
      'Location',
      `/api/v1/orgs/${channel.organizationId}/workspaces/${channel.workspaceId}/channels/${channel.channelId}/messages/${message.id}`,
    );
    return message;
  }

  // Before ':messageId' routes. The cursor moves forward only; the caller needs only to see the channel.
  @Post('read')
  @HttpCode(204)
  @ApiOperation({ summary: 'Move my read cursor forward to a message' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 422, 503)
  async read(
    @CurrentChannel() channel: ChannelAccess,
    @CurrentPrincipal() principal: Principal,
    @Body() dto: ReadMessageDto,
  ): Promise<void> {
    await this.messages.markRead(actorOf(channel, principal), channel, dto.messageId);
  }

  @Get(':messageId/context')
  @ApiOperation({
    summary: 'A message with the messages around it, oldest first. A reply gives the context of its thread root',
  })
  @ApiOkResponse({ type: ContextDto })
  @ApiProblemResponses(401, 404, 422, 503)
  context(
    @CurrentChannel() channel: ChannelAccess,
    @CurrentPrincipal() principal: Principal,
    @Param('messageId', UuidParam()) messageId: string,
    @Query() query: ContextQueryDto,
  ): Promise<ContextDto> {
    return this.messages.context(
      actorOf(channel, principal),
      channel,
      messageId,
      query.before ?? 10,
      query.after ?? 10,
    );
  }

  @Get(':messageId/replies')
  @ApiOperation({ summary: 'Replies of a thread, oldest first' })
  @ApiOkResponse({ type: RepliesListDto })
  @ApiProblemResponses(401, 404, 422, 503)
  replies(
    @CurrentChannel() channel: ChannelAccess,
    @CurrentPrincipal() principal: Principal,
    @Param('messageId', UuidParam()) messageId: string,
    @Query() query: PageQueryDto,
  ): Promise<RepliesListDto> {
    return this.messages.replies(actorOf(channel, principal), channel, messageId, query.limit ?? 50, query.cursor);
  }

  @Put(':messageId/reactions/:emoji')
  @HttpCode(204)
  @ApiOperation({ summary: 'React with an emoji (channel members). Idempotent' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 403, 404, 409, 422, 503)
  async react(
    @CurrentChannel() channel: ChannelAccess,
    @CurrentPrincipal() principal: Principal,
    @Param('messageId', UuidParam()) messageId: string,
    @Param('emoji') emoji: string,
  ): Promise<void> {
    await this.messages.react(actorOf(channel, principal), channel, messageId, emoji, true);
  }

  @Delete(':messageId/reactions/:emoji')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove my reaction (channel members). Idempotent' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 403, 404, 409, 422, 503)
  async unreact(
    @CurrentChannel() channel: ChannelAccess,
    @CurrentPrincipal() principal: Principal,
    @Param('messageId', UuidParam()) messageId: string,
    @Param('emoji') emoji: string,
  ): Promise<void> {
    await this.messages.react(actorOf(channel, principal), channel, messageId, emoji, false);
  }

  @Put(':messageId/bookmark')
  @HttpCode(204)
  @ApiOperation({ summary: 'Save a message for myself. Idempotent' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 409, 503)
  async save(
    @CurrentChannel() channel: ChannelAccess,
    @CurrentPrincipal() principal: Principal,
    @Param('messageId', UuidParam()) messageId: string,
  ): Promise<void> {
    await this.messages.bookmark(actorOf(channel, principal), channel, messageId, true);
  }

  @Delete(':messageId/bookmark')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a saved message. Idempotent' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 503)
  async unsave(
    @CurrentChannel() channel: ChannelAccess,
    @CurrentPrincipal() principal: Principal,
    @Param('messageId', UuidParam()) messageId: string,
  ): Promise<void> {
    await this.messages.bookmark(actorOf(channel, principal), channel, messageId, false);
  }

  @Patch(':messageId')
  @ApiOperation({ summary: 'Edit a message (its sender)' })
  @ApiOkResponse({ type: MessageDto })
  @ApiProblemResponses(401, 403, 404, 409, 422, 503)
  edit(
    @CurrentChannel() channel: ChannelAccess,
    @CurrentPrincipal() principal: Principal,
    @Param('messageId', UuidParam()) messageId: string,
    @Body() dto: EditMessageDto,
    @Req() req: Request,
  ): Promise<MessageDto> {
    return this.messages.edit(actorOf(channel, principal), channel, messageId, dto.body, req);
  }

  @Delete(':messageId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a message (its sender, or a channel admin); erases the body. Idempotent' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 403, 404, 503)
  async remove(
    @CurrentChannel() channel: ChannelAccess,
    @CurrentPrincipal() principal: Principal,
    @Param('messageId', UuidParam()) messageId: string,
  ): Promise<void> {
    await this.messages.remove(actorOf(channel, principal), channel, messageId);
  }
}
