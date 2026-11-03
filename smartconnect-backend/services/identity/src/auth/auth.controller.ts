import { Body, Controller, Get, Header, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, CurrentPrincipal, Public, type Principal } from '@smartconnect/backend-kit';
import type { Request, Response } from 'express';
import { AuthService, type IssuedTokens } from './auth.service.js';
import {
  AcceptedDto,
  LoginDto,
  MeDto,
  RefreshTokenDto,
  RegisterDto,
  TokenResponseDto,
  type TokenDelivery,
} from './dto.js';
import { clearedRefreshCookie, readRefreshCookie, refreshCookie } from './refresh-cookie.js';
import { clientMetadataOf } from './session.service.js';

/** Builds the token response; browsers get the refresh token ONLY as an HttpOnly cookie, never in the body. */
function respondWithTokens(res: Response, tokens: IssuedTokens, delivery: TokenDelivery): TokenResponseDto {
  const body: TokenResponseDto = {
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    expiresIn: tokens.expiresIn,
    sessionId: tokens.sessionId,
    sessionExpiresAt: tokens.sessionExpiresAt.toISOString(),
  };
  if (delivery === 'body') return { ...body, refreshToken: tokens.refreshToken };
  res.setHeader(
    'Set-Cookie',
    refreshCookie(tokens.refreshToken, (tokens.sessionExpiresAt.getTime() - Date.now()) / 1000),
  );
  return body;
}

/** A body token (native apps) takes precedence; otherwise the browser's cookie. */
function presentedRefreshToken(req: Request, dto: RefreshTokenDto): { token?: string; delivery: TokenDelivery } {
  if (dto.refreshToken !== undefined) return { token: dto.refreshToken, delivery: 'body' };
  return { token: readRefreshCookie(req.get('cookie')), delivery: 'cookie' };
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(202)
  @ApiOperation({ summary: 'Register an account. Same 202 for new and already-registered emails (no enumeration)' })
  @ApiAcceptedResponse({ type: AcceptedDto })
  @ApiProblemResponses(400, 415, 422)
  async register(@Body() dto: RegisterDto): Promise<AcceptedDto> {
    await this.auth.register(dto);
    return { status: 'accepted' };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Log in: access token + refresh token (cookie for web, body for native apps)' })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiProblemResponses(400, 401, 415, 422)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponseDto> {
    const tokens = await this.auth.login(dto, clientMetadataOf(req));
    return respondWithTokens(res, tokens, dto.tokenDelivery ?? 'cookie');
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Rotate the refresh token; reuse of an already-rotated token ends the session' })
  @ApiOkResponse({ type: TokenResponseDto })
  @ApiProblemResponses(401, 422)
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponseDto> {
    const { token, delivery } = presentedRefreshToken(req, dto);
    return respondWithTokens(res, await this.auth.refresh(req, token), delivery);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: "End the refresh token's session (idempotent)" })
  @ApiNoContentResponse()
  @ApiProblemResponses(422)
  async logout(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(presentedRefreshToken(req, dto).token);
    res.setHeader('Set-Cookie', clearedRefreshCookie());
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: "The caller's account: id, email, whether it is verified, display name" })
  @ApiOkResponse({ type: MeDto })
  @ApiProblemResponses(401)
  me(@CurrentPrincipal() principal: Principal): Promise<MeDto> {
    return this.auth.me(principal.userId);
  }

  @Post('logout-all')
  @HttpCode(204)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: "End all of the caller's sessions, including this one" })
  @ApiNoContentResponse()
  @ApiProblemResponses(401)
  async logoutAll(@CurrentPrincipal() principal: Principal, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logoutAll(principal.userId);
    res.setHeader('Set-Cookie', clearedRefreshCookie());
  }
}
