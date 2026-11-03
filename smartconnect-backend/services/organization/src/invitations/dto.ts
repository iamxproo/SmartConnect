import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQueryDto, Trim } from '../organizations/dto.js';

export class CreateInvitationDto {
  @ApiProperty({ format: 'email', maxLength: 254 })
  @Trim()
  @IsEmail({ require_tld: true, allow_display_name: false, allow_ip_domain: false })
  @MaxLength(254)
  email!: string;

  @ApiProperty({ format: 'uuid', description: 'Role the person gets on acceptance' })
  @IsUUID()
  roleId!: string;
}

export const invitationStatuses = ['pending', 'accepted', 'revoked', 'expired'] as const;
/** A status, or every invitation whatever its status. */
export const invitationFilters = [...invitationStatuses, 'all'] as const;

export class ListInvitationsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: invitationFilters, default: 'pending' })
  @IsOptional()
  @IsIn(invitationFilters)
  status?: (typeof invitationFilters)[number];
}

/** Invitation tokens travel only in request bodies, never in URLs (which end up in logs). */
export class InvitationTokenDto {
  @ApiProperty({ description: 'The token from the invitation email' })
  @IsString()
  @MaxLength(128)
  token!: string;
}
