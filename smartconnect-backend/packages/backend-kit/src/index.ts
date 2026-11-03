// @smartconnect/backend-kit: shared infrastructure for SmartConnect's NestJS processes (gateway and services).
// HTTP pipeline, RFC 9457 errors, request ids, validation, logging, health, OpenAPI conventions, access-token
// verification and the email transport. No data models and no business logic: those stay in the owning service.
export * from './auth/access-token.js';
export * from './auth/constants.js';
export * from './auth/guard.js';
export * from './config/env.js';
export * from './email/background-mailer.js';
export * from './email/delivery.js';
export * from './email/html.js';
export * from './email/layout.js';
export * from './email/resend-transport.js';
export * from './email/smtp-transport.js';
export * from './health/health.js';
export * from './http/body-handling.js';
export * from './http/dev-mailbox.js';
export * from './http/pipeline.js';
export * from './http/problem-details.filter.js';
export * from './http/problem-details.js';
export * from './http/request-context.js';
export * from './http/request-logging.js';
export * from './http/root-not-found.js';
export * from './http/service-client.js';
export * from './http/validation.js';
export * from './logger.js';
export * from './openapi/decorators.js';
export * from './openapi/document.js';
export * from './openapi/schemas.js';
