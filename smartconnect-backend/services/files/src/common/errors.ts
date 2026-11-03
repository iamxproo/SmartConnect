import { ApiProblemException } from '@smartconnect/backend-kit';

export const notFound = () => new ApiProblemException(404, 'not_found');

/** Prisma error codes, matched structurally (driver-adapter errors are plain objects with a `code`). */
export const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === 'P2002';
