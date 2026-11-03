import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** OpenAPI schema of docs/api/conventions.md problem details (documentation only; see http/problem-details.ts). */
export class FieldErrorDto {
  @ApiProperty({ example: 'name', description: 'Path of the offending field; `(body)` for the whole body.' })
  field!: string;

  @ApiProperty({ example: 'too_long', description: 'Stable machine-readable reason.' })
  code!: string;

  @ApiProperty({ example: 'name must be shorter than or equal to 80 characters' })
  message!: string;
}

export class ProblemDetailsDto {
  @ApiProperty({ example: 'https://docs.smartconnect.dev/errors/validation-failed', format: 'uri' })
  type!: string;

  @ApiProperty({ example: 'Request validation failed' })
  title!: string;

  @ApiProperty({ example: 422 })
  status!: number;

  @ApiProperty({ example: 'validation_failed', description: 'Stable identifier clients branch on.' })
  code!: string;

  @ApiProperty({ example: '1 validation error' })
  detail!: string;

  @ApiProperty({ example: '/api/v1/example', description: 'Request path (no query string).' })
  instance!: string;

  @ApiProperty({
    example: '0f9d2c4e-8a51-4c4f-9a8e-4f6f0f3b6a1d',
    description: 'Same value as the X-Request-Id header.',
  })
  requestId!: string;

  @ApiPropertyOptional({ type: () => [FieldErrorDto], description: 'Present for validation errors (422).' })
  errors?: FieldErrorDto[];
}
