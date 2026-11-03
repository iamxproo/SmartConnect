import { ApiProperty } from '@nestjs/swagger';

/** Platform-wide account totals for the Super Admin dashboard. Deleted accounts are not counted. */
export class AccountSummaryDto {
  @ApiProperty({ description: 'All accounts' })
  total!: number;

  @ApiProperty({ description: 'Accounts whose email address is verified' })
  verified!: number;

  @ApiProperty()
  active!: number;

  @ApiProperty()
  suspended!: number;

  @ApiProperty()
  deactivated!: number;

  @ApiProperty({ description: 'Accounts holding the super_admin platform role' })
  superAdmins!: number;
}
