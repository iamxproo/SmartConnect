// Public surface of the identity service's authentication API. Each route states explicitly whether it is public
// and which rate-limit buckets protect it, then forwards to the identity service, which owns validation and all
// behaviour. Request/response schemas: the identity service's OpenAPI document (ADR 0009).
import { Controller, Delete, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiProblemResponses, BEARER_AUTH, Public, REFRESH_TOKEN_COOKIE } from '@smartconnect/backend-kit';
import type { Request, Response } from 'express';
import { RateLimit, type RateLimitRule } from '../rate-limit/rate-limit.js';
import { UpstreamProxy } from '../proxy/upstream-proxy.js';

const MINUTE = 60;
const HOUR = 60 * MINUTE;

const perIp = (name: string, limit: number, windowSeconds: number): RateLimitRule => ({
  name,
  key: 'ip',
  limit,
  windowSeconds,
});
const perAccount = (name: string, limit: number, windowSeconds: number): RateLimitRule => ({
  name,
  key: { bodyField: 'email' },
  limit,
  windowSeconds,
});
const perUser = (name: string, limit: number, windowSeconds: number): RateLimitRule => ({
  name,
  key: 'user',
  limit,
  windowSeconds,
});

/** Brute-force and abuse limits (ADR 0009). Per-account buckets apply to unknown emails too: no enumeration. */
export const AUTH_RATE_LIMITS = {
  register: [perIp('register-ip', 10, HOUR)],
  login: [perIp('login-ip', 20, 10 * MINUTE), perAccount('login-account', 10, 15 * MINUTE)],
  refresh: [perIp('refresh-ip', 60, MINUTE)],
  logout: [perIp('logout-ip', 60, MINUTE)],
  passwordForgot: [perIp('password-forgot-ip', 10, HOUR), perAccount('password-forgot-account', 3, HOUR)],
  passwordReset: [perIp('password-reset-ip', 20, HOUR)],
  passwordChange: [perUser('password-change-user', 5, 15 * MINUTE)],
  emailVerify: [perIp('email-verify-ip', 20, HOUR)],
  emailResend: [perUser('email-resend-user', 5, HOUR)],
  sessions: [perUser('sessions-user', 60, MINUTE)],
} satisfies Record<string, RateLimitRule[]>;

/** The identity service sees only the refresh cookie, never other cookies of the domain. */
const IDENTITY_COOKIES = [REFRESH_TOKEN_COOKIE];

@ApiTags('Auth')
@Controller('auth')
export class AuthRoutesController {
  constructor(@Inject(UpstreamProxy) private readonly proxy: UpstreamProxy) {}

  private forward(req: Request, res: Response): Promise<void> {
    return this.proxy.forward('identity', req, res, { cookies: IDENTITY_COOKIES });
  }

  @Public()
  @Post('register')
  @RateLimit(...AUTH_RATE_LIMITS.register)
  @ApiOperation({ summary: 'Register an account. Same 202 for new and already-registered emails (no enumeration)' })
  @ApiResponse({ status: 202, description: 'Accepted' })
  @ApiProblemResponses(400, 415, 422, 429)
  register(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Public()
  @Post('login')
  @RateLimit(...AUTH_RATE_LIMITS.login)
  @ApiOperation({ summary: 'Log in with email and password: access token + rotating refresh token, new session' })
  @ApiResponse({ status: 200, description: 'Tokens issued' })
  @ApiProblemResponses(400, 401, 415, 422, 429)
  login(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Public()
  @Post('refresh')
  @RateLimit(...AUTH_RATE_LIMITS.refresh)
  @ApiOperation({ summary: 'Rotate the refresh token (cookie or body) and issue a new access token' })
  @ApiResponse({ status: 200, description: 'Tokens rotated' })
  @ApiProblemResponses(401, 403, 422, 429)
  refresh(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Public()
  @Post('logout')
  @RateLimit(...AUTH_RATE_LIMITS.logout)
  @ApiOperation({ summary: "End the refresh token's session (idempotent)" })
  @ApiResponse({ status: 204, description: 'Logged out' })
  @ApiProblemResponses(403, 422, 429)
  logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Get('me')
  @RateLimit(...AUTH_RATE_LIMITS.sessions)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: "The caller's account: id, email, whether it is verified, display name" })
  @ApiResponse({ status: 200, description: 'The account' })
  @ApiProblemResponses(401, 429)
  me(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Public()
  @Post('email/verify')
  @RateLimit(...AUTH_RATE_LIMITS.emailVerify)
  @ApiOperation({ summary: 'Verify the email address with the token from the verification email' })
  @ApiResponse({ status: 204, description: 'Verified' })
  @ApiProblemResponses(400, 422, 429)
  verifyEmail(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Post('email/verification')
  @RateLimit(...AUTH_RATE_LIMITS.emailResend)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: 'Send a new verification email (if the address is not verified yet)' })
  @ApiResponse({ status: 202, description: 'Accepted' })
  @ApiProblemResponses(401, 429)
  resendVerification(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Post('logout-all')
  @RateLimit(...AUTH_RATE_LIMITS.sessions)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: "End all of the caller's sessions, including this one" })
  @ApiResponse({ status: 204, description: 'All sessions ended' })
  @ApiProblemResponses(401, 429)
  logoutAll(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Get('sessions')
  @RateLimit(...AUTH_RATE_LIMITS.sessions)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: "List the caller's active sessions (cursor-paginated)" })
  @ApiResponse({ status: 200, description: 'Active sessions' })
  @ApiProblemResponses(401, 422, 429)
  listSessions(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Post('sessions/revoke-others')
  @RateLimit(...AUTH_RATE_LIMITS.sessions)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: "End every session of the caller's except the current one" })
  @ApiResponse({ status: 204, description: 'Other sessions ended' })
  @ApiProblemResponses(401, 429)
  revokeOtherSessions(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Delete('sessions/:sessionId')
  @RateLimit(...AUTH_RATE_LIMITS.sessions)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: "End one of the caller's sessions (404 for anyone else's)" })
  @ApiResponse({ status: 204, description: 'Session ended' })
  @ApiProblemResponses(401, 404, 429)
  revokeSession(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Public()
  @Post('password/forgot')
  @RateLimit(...AUTH_RATE_LIMITS.passwordForgot)
  @ApiOperation({ summary: 'Request a password-reset email. Same 202 whether or not the account exists' })
  @ApiResponse({ status: 202, description: 'Accepted' })
  @ApiProblemResponses(422, 429)
  forgotPassword(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Public()
  @Post('password/reset')
  @RateLimit(...AUTH_RATE_LIMITS.passwordReset)
  @ApiOperation({ summary: 'Set a new password with a single-use reset token; ends every session' })
  @ApiResponse({ status: 204, description: 'Password reset' })
  @ApiProblemResponses(400, 422, 429)
  resetPassword(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }

  @Post('password/change')
  @RateLimit(...AUTH_RATE_LIMITS.passwordChange)
  @ApiBearerAuth(BEARER_AUTH)
  @ApiOperation({ summary: 'Change the password (current password required); ends every other session' })
  @ApiResponse({ status: 204, description: 'Password changed' })
  @ApiProblemResponses(401, 403, 422, 429)
  changePassword(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.forward(req, res);
  }
}
