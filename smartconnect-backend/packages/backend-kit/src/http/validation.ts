import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { ApiProblemException, type FieldError } from './problem-details.js';

/** class-validator constraint names → stable codes clients can branch on (others become snake_case). */
const CODES: Record<string, string> = {
  whitelistValidation: 'unknown_field',
  unknownValue: 'invalid_body',
  isDefined: 'required',
  isNotEmpty: 'required',
  maxLength: 'too_long',
  minLength: 'too_short',
  max: 'too_large',
  min: 'too_small',
  isString: 'invalid_type',
  isInt: 'invalid_type',
  isNumber: 'invalid_type',
  isBoolean: 'invalid_type',
  isObject: 'invalid_type',
  isArray: 'invalid_type',
  isEmail: 'invalid_email',
  isUuid: 'invalid_uuid',
  isEnum: 'invalid_value',
  isIn: 'invalid_value',
};

const toSnakeCase = (name: string) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((error) => {
    const property = error.property;
    const field =
      property === undefined || property === ''
        ? parent || '(body)'
        : /^\d+$/.test(property)
          ? `${parent}[${property}]`
          : parent
            ? `${parent}.${property}`
            : property;
    const own = Object.entries(error.constraints ?? {}).map(([constraint, message]) => ({
      field,
      code: CODES[constraint] ?? toSnakeCase(constraint),
      message,
    }));
    return [...own, ...flattenValidationErrors(error.children ?? [], field)];
  });
}

/**
 * Global DTO validation (docs/api/conventions.md#validation-and-limits): unknown properties are rejected, values are
 * transformed into DTO instances, and errors never echo submitted values (they may be secrets).
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => {
      const fieldErrors = flattenValidationErrors(errors);
      return new ApiProblemException(
        422,
        'validation_failed',
        `${fieldErrors.length} validation error${fieldErrors.length === 1 ? '' : 's'}`,
        fieldErrors,
      );
    },
  });
}
