import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { Trim } from '../organizations/dto.js';

export class CreateDepartmentDto {
  @ApiProperty({ maxLength: 120 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Parent department' })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class UpdateDepartmentDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  parentId?: string | null;
}

export const teamVisibilities = ['public', 'private'] as const;
export const teamRoles = ['lead', 'member'] as const;

export class CreateTeamDto {
  @ApiProperty({ maxLength: 120 })
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiProperty({ enum: teamVisibilities, description: 'Required: private teams are visible only to their members' })
  @IsIn(teamVisibilities)
  visibility!: (typeof teamVisibilities)[number];
}

export class UpdateTeamDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @Trim()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @Trim()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  departmentId?: string | null;

  @ApiPropertyOptional({ enum: teamVisibilities })
  @IsOptional()
  @IsIn(teamVisibilities)
  visibility?: (typeof teamVisibilities)[number];
}

export class ListTeamsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

export class PutTeamMemberDto {
  @ApiProperty({ enum: teamRoles })
  @IsIn(teamRoles)
  role!: (typeof teamRoles)[number];
}
