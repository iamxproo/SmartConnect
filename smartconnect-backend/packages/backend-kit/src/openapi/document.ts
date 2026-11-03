import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { ProblemDetailsDto, FieldErrorDto } from './schemas.js';

export const DOCS_PATH = 'docs';
export const OPENAPI_JSON_PATH = 'docs/openapi.json';

const PROBLEM_SCHEMA_REF = '#/components/schemas/ProblemDetailsDto';

/** Name of the bearer security scheme; protected operations reference it with `@ApiBearerAuth(BEARER_AUTH)`. */
export const BEARER_AUTH = 'accessToken';

export interface OpenApiInfo {
  title: string;
  description: string;
}

/**
 * Builds a service's OpenAPI 3.1 document and applies the repository-wide conventions to every operation:
 * the X-Request-Id response header and a documented 500 problem response.
 */
export function buildOpenApiDocument(app: INestApplication, info: OpenApiInfo): OpenAPIObject {
  const config = new DocumentBuilder()
    .setOpenAPIVersion('3.1.0')
    .setTitle(info.title)
    .setDescription(info.description)
    .setVersion('v1')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'Access token from /api/v1/auth/login' },
      BEARER_AUTH,
    )
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [ProblemDetailsDto, FieldErrorDto],
    operationIdFactory: (controllerKey, methodKey) => `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
  });
  return applyConventions(document);
}

function applyConventions(document: OpenAPIObject): OpenAPIObject {
  document.components ??= {};
  document.components.headers = {
    ...document.components.headers,
    XRequestId: {
      description:
        'Request id: echoed from a valid inbound X-Request-Id or generated; also in problem bodies and logs.',
      schema: { type: 'string' },
    },
  };
  for (const pathItem of Object.values(document.paths)) {
    for (const method of ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const) {
      const operation = pathItem[method];
      if (!operation) continue;
      operation.responses['500'] ??= {
        description: 'Internal server error',
        content: { 'application/problem+json': { schema: { $ref: PROBLEM_SCHEMA_REF } } },
      };
      for (const response of Object.values(operation.responses)) {
        if (!response || '$ref' in response) continue;
        response.headers = { ...response.headers, 'X-Request-Id': { $ref: '#/components/headers/XRequestId' } };
      }
    }
  }
  return document;
}

/** Swagger UI at /docs and the raw document at /docs/openapi.json (only when API_DOCS_ENABLED). */
export function setupOpenApi(app: INestApplication, document: OpenAPIObject): void {
  SwaggerModule.setup(DOCS_PATH, app, document, {
    jsonDocumentUrl: OPENAPI_JSON_PATH,
    raw: ['json'],
    customSiteTitle: document.info.title,
  });
}
