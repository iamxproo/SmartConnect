import { ParseUUIDPipe } from '@nestjs/common';
import { notFound } from './errors.js';

/** A malformed id is just another resource the caller cannot see: 404, not a validation error. */
export const UuidParam = () => new ParseUUIDPipe({ exceptionFactory: () => notFound() });
