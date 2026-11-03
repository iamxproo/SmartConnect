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
import { CurrentOrg, OrganizationScoped } from '../access/access.guard.js';
import type { OrgMembership } from '../access/organization-directory.js';
import { UuidParam } from '../common/uuid-param.js';
import { ContextQueryDto, EditMessageDto, PageQueryDto, PostMessageDto } from '../messages/dto.js';
import type { Actor } from './access.js';
import { ConversationMessagesService } from './conversation-messages.service.js';
import { ConversationsService } from './conversations.service.js';
import {
  ConversationContextDto,
  ConversationDto,
  ConversationListDto,
  ConversationMessageDto,
  ConversationMessageListDto,
  ConversationRepliesListDto,
  DirectDto,
  GroupDto,
  InboxDto,
  ParticipantDto,
  ParticipantRoleDto,
  ReadDto,
  RenameDto,
} from './dto.js';

const actorOf = (org: OrgMembership, principal: Principal): Actor => ({
  organizationId: org.organizationId,
  userId: principal.userId.toLowerCase(),
});

/** Every route is protected: AccessTokenGuard authenticates, AccessGuard asks the organization service. */
@ApiTags('Conversations')
@ApiBearerAuth(BEARER_AUTH)
@OrganizationScoped()
@Controller('orgs/:orgId/conversations')
export class ConversationsController {
  constructor(
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(ConversationMessagesService) private readonly messages: ConversationMessagesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My direct and group conversations, most recent activity first' })
  @ApiOkResponse({ type: ConversationListDto })
  @ApiProblemResponses(401, 404, 422, 503)
  list(@CurrentOrg() org: OrgMembership, @CurrentPrincipal() principal: Principal, @Query() query: PageQueryDto) {
    return this.conversations.list(actorOf(org, principal), query.limit ?? 50, query.cursor);
  }

  @Post('direct')
  @ApiOperation({ summary: 'Find or create the direct conversation with another member (201 created, 200 existing)' })
  @ApiCreatedResponse({ type: ConversationDto })
  @ApiOkResponse({ type: ConversationDto })
  @ApiProblemResponses(401, 404, 422, 503)
  async direct(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Body() dto: DirectDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConversationDto> {
    const { conversation, created } = await this.conversations.openDirect(actorOf(org, principal), dto.userId, req);
    res.status(created ? 201 : 200);
    res.setHeader('Location', `/api/v1/orgs/${org.organizationId}/conversations/${conversation.id}`);
    return conversation;
  }

  @Post('groups')
  @ApiOperation({ summary: 'Create a group; the caller becomes its admin' })
  @ApiCreatedResponse({ type: ConversationDto })
  @ApiProblemResponses(401, 404, 422, 503)
  async group(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Body() dto: GroupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConversationDto> {
    const conversation = await this.conversations.createGroup(actorOf(org, principal), dto, req);
    res.setHeader('Location', `/api/v1/orgs/${org.organizationId}/conversations/${conversation.id}`);
    return conversation;
  }

  // Before ':id'. The realtime gateway asks this before joining a socket to the caller's inbox; the guard has already
  // checked the organization membership and dropped leftovers of an earlier one.
  @Get('inbox')
  @ApiOperation({ summary: "Whether the caller may follow this organization's conversation inbox (realtime gateway)" })
  @ApiOkResponse({ type: InboxDto })
  @ApiProblemResponses(401, 404, 503)
  inbox(@CurrentOrg() org: OrgMembership): InboxDto {
    return { organizationId: org.organizationId };
  }

  @Get(':id')
  @ApiOperation({ summary: 'A conversation I participate in' })
  @ApiOkResponse({ type: ConversationDto })
  @ApiProblemResponses(401, 404, 503)
  get(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
  ) {
    return this.conversations.get(actorOf(org, principal), id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename a group (admins)' })
  @ApiOkResponse({ type: ConversationDto })
  @ApiProblemResponses(401, 403, 404, 409, 422, 503)
  rename(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Body() dto: RenameDto,
  ) {
    return this.conversations.rename(actorOf(org, principal), id, dto.title);
  }

  @Put(':id/participants/:userId')
  @ApiOperation({ summary: 'Add a participant (201) or change their role (200); group admins' })
  @ApiCreatedResponse({ type: ParticipantDto })
  @ApiOkResponse({ type: ParticipantDto })
  @ApiProblemResponses(401, 403, 404, 409, 422, 503)
  async putParticipant(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Param('userId', UuidParam()) userId: string,
    @Body() dto: ParticipantRoleDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ParticipantDto> {
    const { participant, created } = await this.conversations.putParticipant(
      actorOf(org, principal),
      id,
      userId.toLowerCase(),
      dto.role,
      req,
    );
    res.status(created ? 201 : 200);
    return participant;
  }

  @Delete(':id/participants/:userId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a participant (group admins) or leave (anyone)' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 403, 404, 409, 503)
  async removeParticipant(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Param('userId', UuidParam()) userId: string,
  ): Promise<void> {
    await this.conversations.removeParticipant(actorOf(org, principal), id, userId.toLowerCase());
  }

  @Post(':id/read')
  @HttpCode(204)
  @ApiOperation({ summary: 'Move my read cursor forward to a message' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 422, 503)
  async read(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Body() dto: ReadDto,
  ): Promise<void> {
    await this.conversations.markRead(actorOf(org, principal), id, dto.messageId);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Messages from my join onward, newest first' })
  @ApiOkResponse({ type: ConversationMessageListDto })
  @ApiProblemResponses(401, 404, 422, 503)
  listMessages(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Query() query: PageQueryDto,
  ) {
    return this.messages.list(actorOf(org, principal), id, query.limit ?? 50, query.cursor);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Post a message. A repeated clientMessageId returns the original (200)' })
  @ApiCreatedResponse({ type: ConversationMessageDto })
  @ApiOkResponse({ type: ConversationMessageDto })
  @ApiProblemResponses(401, 404, 409, 422, 503)
  async post(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Body() dto: PostMessageDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConversationMessageDto> {
    const { message, created } = await this.messages.post(
      actorOf(org, principal),
      id,
      { ...dto, body: dto.body ?? '' },
      req,
    );
    res.status(created ? 201 : 200);
    res.setHeader('Location', `/api/v1/orgs/${org.organizationId}/conversations/${id}/messages/${message.id}`);
    return message;
  }

  @Get(':id/messages/:messageId/context')
  @ApiOperation({
    summary:
      "A message with the messages around it (from my join onward), oldest first. A reply gives its root's context",
  })
  @ApiOkResponse({ type: ConversationContextDto })
  @ApiProblemResponses(401, 404, 422, 503)
  context(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Param('messageId', UuidParam()) messageId: string,
    @Query() query: ContextQueryDto,
  ) {
    return this.messages.context(actorOf(org, principal), id, messageId, query.before ?? 10, query.after ?? 10);
  }

  @Get(':id/messages/:messageId/replies')
  @ApiOperation({ summary: 'Replies of a thread, oldest first' })
  @ApiOkResponse({ type: ConversationRepliesListDto })
  @ApiProblemResponses(401, 404, 422, 503)
  replies(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Param('messageId', UuidParam()) messageId: string,
    @Query() query: PageQueryDto,
  ) {
    return this.messages.replies(actorOf(org, principal), id, messageId, query.limit ?? 50, query.cursor);
  }

  @Put(':id/messages/:messageId/reactions/:emoji')
  @HttpCode(204)
  @ApiOperation({ summary: 'React with an emoji. Idempotent' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 409, 422, 503)
  async react(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Param('messageId', UuidParam()) messageId: string,
    @Param('emoji') emoji: string,
  ): Promise<void> {
    await this.messages.react(actorOf(org, principal), id, messageId, emoji, true);
  }

  @Delete(':id/messages/:messageId/reactions/:emoji')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove my reaction. Idempotent' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 409, 422, 503)
  async unreact(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Param('messageId', UuidParam()) messageId: string,
    @Param('emoji') emoji: string,
  ): Promise<void> {
    await this.messages.react(actorOf(org, principal), id, messageId, emoji, false);
  }

  @Put(':id/messages/:messageId/bookmark')
  @HttpCode(204)
  @ApiOperation({ summary: 'Save a message for myself. Idempotent' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 409, 503)
  async save(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Param('messageId', UuidParam()) messageId: string,
  ): Promise<void> {
    await this.messages.bookmark(actorOf(org, principal), id, messageId, true);
  }

  @Delete(':id/messages/:messageId/bookmark')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a saved message. Idempotent' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404, 503)
  async unsave(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Param('messageId', UuidParam()) messageId: string,
  ): Promise<void> {
    await this.messages.bookmark(actorOf(org, principal), id, messageId, false);
  }

  @Patch(':id/messages/:messageId')
  @ApiOperation({ summary: 'Edit a message (its sender)' })
  @ApiOkResponse({ type: ConversationMessageDto })
  @ApiProblemResponses(401, 403, 404, 409, 422, 503)
  edit(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Param('messageId', UuidParam()) messageId: string,
    @Body() dto: EditMessageDto,
  ) {
    return this.messages.edit(actorOf(org, principal), id, messageId, dto.body);
  }

  @Delete(':id/messages/:messageId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a message (its sender, or a group admin); erases the body. Idempotent' })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 403, 404, 503)
  async remove(
    @CurrentOrg() org: OrgMembership,
    @CurrentPrincipal() principal: Principal,
    @Param('id', UuidParam()) id: string,
    @Param('messageId', UuidParam()) messageId: string,
  ): Promise<void> {
    await this.messages.remove(actorOf(org, principal), id, messageId);
  }
}
