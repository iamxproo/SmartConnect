import { applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { defaultsFor } from '../http/problem-details.js';
import { ProblemDetailsDto } from './schemas.js';

/**
 * Documents the problem responses an operation can return, e.g. `@ApiProblemResponses(404, 422)`.
 * 500 is added to every operation automatically (openapi/document.ts), so it need not be listed.
 */
export function ApiProblemResponses(...statuses: number[]) {
  return applyDecorators(
    ApiExtraModels(ProblemDetailsDto),
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: defaultsFor(status).title,
        content: { 'application/problem+json': { schema: { $ref: getSchemaPath(ProblemDetailsDto) } } },
      }),
    ),
  );
}
