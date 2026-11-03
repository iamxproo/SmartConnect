import { ApiProblemException } from '@smartconnect/backend-kit';

export const notFound = () => new ApiProblemException(404, 'not_found');
export const forbidden = (code = 'forbidden', detail?: string) => new ApiProblemException(403, code, detail);
export const conflict = (code: string, detail: string) => new ApiProblemException(409, code, detail);
export const unavailable = () =>
  new ApiProblemException(503, 'dependency_unavailable', 'A required service is temporarily unavailable.');
export const invalid = (field: string, code: string, message: string) =>
  new ApiProblemException(422, 'validation_failed', '1 validation error', [{ field, code, message }]);
