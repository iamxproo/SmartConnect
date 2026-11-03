import { Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiProblemException,
  ApiProblemResponses,
  BEARER_AUTH,
  CurrentPrincipal,
  type Principal,
} from '@smartconnect/backend-kit';
import type { Response } from 'express';
import { AuthService } from './auth.service.js';
import { ListSessionsQueryDto, SessionListDto } from './dto.js';
import { sessionNotFound } from './errors.js';
import { clearedRefreshCookie } from './refresh-cookie.js';
import { SessionService } from './session.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Cursor = base64url of the last session id on the page (opaque to clients). */
const encodeCursor = (id: string) => Buffer.from(id).toString('base64url');
function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!UUID.test(id)) {
    throw new ApiProblemException(422, 'validation_failed', '1 validation error', [
      { field: 'cursor', code: 'invalid_cursor', message: 'cursor is not a valid page cursor' },
    ]);
  }
  return id;
}

/** Every route here is protected (global AccessTokenGuard + ActiveSessionGuard) and scoped to the caller. */
@ApiTags('Sessions')
@ApiBearerAuth(BEARER_AUTH)
@Controller('auth/sessions')
export class SessionsController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  @Get()
  @ApiOperation({ summary: "The caller's active sessions, newest first" })
  @ApiOkResponse({ type: SessionListDto })
  @ApiProblemResponses(401, 422)
  async list(@CurrentPrincipal() principal: Principal, @Query() query: ListSessionsQueryDto): Promise<SessionListDto> {
    const { sessions, nextAfterId } = await this.sessions.listActive(
      principal,
      query.limit ?? 50,
      decodeCursor(query.cursor),
    );
    return {
      data: sessions.map((session) => ({
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        lastUsedAt: session.lastUsedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        current: session.current,
      })),
      nextCursor: nextAfterId ? encodeCursor(nextAfterId) : null,
    };
  }

  @Post('revoke-others')
  @HttpCode(204)
  @ApiOperation({ summary: "End every session of the caller's except the current one" })
  @ApiNoContentResponse()
  @ApiProblemResponses(401)
  async revokeOthers(@CurrentPrincipal() principal: Principal): Promise<void> {
    await this.auth.revokeOtherSessions(principal);
  }

  @Delete(':sessionId')
  @HttpCode(204)
  @ApiOperation({ summary: "End one of the caller's sessions. 404 for unknown sessions and other users' sessions" })
  @ApiNoContentResponse()
  @ApiProblemResponses(401, 404)
  async revoke(
    @CurrentPrincipal() principal: Principal,
    // A malformed id is just another session the caller does not have: 404, not a validation error.
    @Param('sessionId', new ParseUUIDPipe({ exceptionFactory: () => sessionNotFound() })) sessionId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (!(await this.sessions.revokeOwned(principal.userId, sessionId, 'revoked_by_user'))) throw sessionNotFound();
    if (sessionId === principal.sessionId) res.setHeader('Set-Cookie', clearedRefreshCookie());
  }
}
