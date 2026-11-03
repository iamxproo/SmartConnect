import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { PageInfoDto, PageQueryDto } from '../common/pagination.js';
import { MAX_RAW_NAME_LENGTH } from './names.js';

export const fileStatuses = ['pending_upload', 'scanning', 'available', 'quarantined', 'deleted'] as const;
export type FileStatusValue = (typeof fileStatuses)[number];

export class CreateFileDto {
  @ApiProperty({
    maxLength: MAX_RAW_NAME_LENGTH,
    description: 'Display name. Path separators, control and direction-override characters are stripped.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_RAW_NAME_LENGTH)
  name!: string;

  @ApiProperty({
    minimum: 1,
    description: 'Exact size of the bytes that will be uploaded; also bounded by the server maximum',
  })
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  sizeBytes!: number;
}

export class FileDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: 'Detected from the content after upload; application/octet-stream before' })
  mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({ enum: fileStatuses }) status!: FileStatusValue;
  @ApiProperty({ format: 'uuid' }) uploadedByUserId!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}

export class FileListDto extends PageInfoDto {
  @ApiProperty({ type: [FileDto] }) data!: FileDto[];
}

export class ListFilesQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 100,
    description: 'Case-insensitive substring of the file name (literal: % and _ are not wildcards)',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  q?: string;
}

export class SignedDownloadDto {
  @ApiProperty({ description: 'Presigned link to the bytes; anyone holding it can read the file until it expires' })
  url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
