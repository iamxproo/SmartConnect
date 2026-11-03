// Request and response contracts of the identity API. Validation runs in the global ValidationPipe (unknown fields
// rejected, no implicit conversion, values never echoed in errors). Password policy per NIST SP 800-63B: length,
// not composition rules: 12 to 128 characters.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength } from 'class-validator';

const Trim = () => Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
const EMAIL_MAX_LENGTH = 254; // RFC 5321 path limit

export class RegisterDto {
  @ApiProperty({ format: 'email', maxLength: EMAIL_MAX_LENGTH, example: 'ada@example.com' })
  @Trim()
  @IsEmail({ require_tld: true, allow_display_name: false, allow_ip_domain: false })
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @ApiProperty({ format: 'password', minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiProperty({ minLength: 1, maxLength: 80, example: 'Ada Lovelace' })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  displayName!: string;
}

export const tokenDeliveries = ['cookie', 'body'] as const;
export type TokenDelivery = (typeof tokenDeliveries)[number];

export class LoginDto {
  @ApiProperty({ format: 'email', maxLength: EMAIL_MAX_LENGTH })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;

  @ApiProperty({ format: 'password', maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiPropertyOptional({
    enum: tokenDeliveries,
    default: 'cookie',
    description:
      '"cookie" (web, default): refresh token only in an HttpOnly cookie. "body" (native apps): in the response ' +
      'body, for the OS secure store.',
  })
  @IsOptional()
  @IsIn(tokenDeliveries)
  tokenDelivery?: TokenDelivery;
}

/** Refresh and logout: native apps send the token in the body; browsers send the cookie and an empty body. */
export class RefreshTokenDto {
  @ApiPropertyOptional({ description: 'Native apps only. Browsers rely on the refresh cookie.' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  refreshToken?: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ format: 'email', maxLength: EMAIL_MAX_LENGTH })
  @Trim()
  @IsEmail({ require_tld: true, allow_display_name: false, allow_ip_domain: false })
  @MaxLength(EMAIL_MAX_LENGTH)
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'The token from the reset email' })
  @IsString()
  @MaxLength(128)
  token!: string;

  @ApiProperty({ format: 'password', minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}

export class VerifyEmailDto {
  @ApiProperty({ description: 'The token from the verification email' })
  @IsString()
  @MaxLength(128)
  token!: string;
}

export class ChangePasswordDto {
  @ApiProperty({ format: 'password', maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;

  @ApiProperty({ format: 'password', minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}

export class ListSessionsQueryDto {
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
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  cursor?: string;
}

// ---- Responses ---------------------------------------------------------------------------------------------------

export class AcceptedDto {
  @ApiProperty({ enum: ['accepted'] })
  status!: 'accepted';
}

export class MeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty()
  emailVerified!: boolean;

  @ApiProperty({ type: String, nullable: true })
  displayName!: string | null;

  @ApiProperty({
    enum: ['super_admin'],
    isArray: true,
    description: 'Platform-wide roles (ADR 0015); empty for almost everyone. Organization roles are separate.',
  })
  platformRoles!: 'super_admin'[];

  @ApiProperty({
    description:
      'The password was issued by someone else (the development Super Admin seed) and must be changed before ' +
      'platform administration can be used',
  })
  passwordChangeRequired!: boolean;
}

export class TokenResponseDto {
  @ApiProperty({ description: 'Short-lived JWT for the Authorization: Bearer header. Keep it in memory only.' })
  accessToken!: string;

  @ApiProperty({ enum: ['Bearer'] })
  tokenType!: 'Bearer';

  @ApiProperty({ description: 'Access-token lifetime in seconds', example: 900 })
  expiresIn!: number;

  @ApiProperty({ format: 'uuid' })
  sessionId!: string;

  @ApiProperty({ format: 'date-time', description: 'When the session ends unless refreshed again' })
  sessionExpiresAt!: string;

  @ApiPropertyOptional({ description: 'Only with tokenDelivery "body" (native apps). Never sent to browsers.' })
  refreshToken?: string;
}

export class SessionDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  lastUsedAt!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Client address when the session was created' })
  ipAddress!: string | null;

  @ApiProperty({ type: String, nullable: true })
  userAgent!: string | null;

  @ApiProperty({ description: 'The session the request was made with' })
  current!: boolean;
}

export class SessionListDto {
  @ApiProperty({ type: [SessionDto] })
  data!: SessionDto[];

  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;
}
