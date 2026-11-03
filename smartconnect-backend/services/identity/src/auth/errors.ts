import { ApiProblemException } from '@smartconnect/backend-kit';
import { clearedRefreshCookie } from './refresh-cookie.js';

/** One generic failure for unknown email, wrong password and inactive account alike: no enumeration. */
export const invalidCredentials = () =>
  new ApiProblemException(401, 'invalid_credentials', 'The email or password is incorrect.');

/**
 * Unknown, expired, revoked or reused refresh token. The same answer in every case, and the refresh cookie is
 * cleared so a browser stops presenting it.
 */
export const invalidRefreshToken = () =>
  new ApiProblemException(401, 'invalid_refresh_token', 'The refresh token is invalid or has expired.', undefined, {
    'Set-Cookie': clearedRefreshCookie(),
  });

/** The access token is valid but its session has ended (logout, revocation, password change). */
export const sessionEnded = () =>
  new ApiProblemException(401, 'session_revoked', 'This session has ended; log in again.', undefined, {
    'WWW-Authenticate': 'Bearer realm="smartconnect", error="invalid_token"',
  });

export const invalidResetToken = () =>
  new ApiProblemException(400, 'invalid_reset_token', 'The password reset link is invalid, used or expired.');

export const invalidVerificationToken = () =>
  new ApiProblemException(
    400,
    'invalid_verification_token',
    'The verification link is invalid, used or expired. Request a new one.',
  );

export const currentPasswordIncorrect = () =>
  new ApiProblemException(403, 'current_password_incorrect', 'The current password is incorrect.');

export const newPasswordSameAsIssued = () =>
  new ApiProblemException(422, 'validation_failed', '1 validation error', [
    {
      field: 'newPassword',
      code: 'same_as_current',
      message: 'Choose a password different from the one you were given.',
    },
  ]);

export const sessionNotFound = () => new ApiProblemException(404, 'not_found');

/** Platform administration (ADR 0015). The same answer for every account without the role, active or not. */
export const platformAdminRequired = () =>
  new ApiProblemException(403, 'platform_admin_required', 'This area is for platform administrators only.');

/** A Super Admin still holding the issued initial password: it must be changed first. */
export const passwordChangeRequired = () =>
  new ApiProblemException(
    403,
    'password_change_required',
    'Change the initial password before using platform administration.',
  );

/** Prisma error codes, matched structurally (driver-adapter errors are plain objects with a `code`). */
export const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === 'P2002';
