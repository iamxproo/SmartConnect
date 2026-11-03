import { ApiProblemException } from '@smartconnect/backend-kit';

/** Prisma error codes, matched structurally (driver-adapter errors are plain objects with a `code`). */
export const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === 'P2002';
/** Foreign-key violation (e.g. deleting a department that still has children or teams). */
export const isForeignKeyViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === 'P2003';

export const conflict = (code: string, detail: string) => new ApiProblemException(409, code, detail);
export const forbidden = (detail: string, code = 'forbidden') => new ApiProblemException(403, code, detail);

export const invalidField = (field: string, code: string, message: string) =>
  new ApiProblemException(422, 'validation_failed', '1 validation error', [{ field, code, message }]);

/** Platform administration (ADR 0015). The same answer for every account without the role. */
export const platformAdminRequired = () =>
  new ApiProblemException(403, 'platform_admin_required', 'This area is for platform administrators only.');

/** A Super Admin still holding the issued initial password: it must be changed first. */
export const passwordChangeRequired = () =>
  new ApiProblemException(
    403,
    'password_change_required',
    'Change the initial password before using platform administration.',
  );
