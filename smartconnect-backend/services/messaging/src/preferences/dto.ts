import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { ActivityLocationDto } from '../activity/dto.js';

export const LEVELS = ['all', 'mentions', 'none'] as const;
export type Level = (typeof LEVELS)[number];

export class SetLevelDto {
  @ApiProperty({
    enum: LEVELS,
    description: '`all` removes the preference; `mentions` hides thread replies; `none` hides everything',
  })
  @IsIn(LEVELS)
  level!: Level;
}

export class LevelDto {
  @ApiProperty({ enum: LEVELS }) level!: Level;
}

export class NotificationPreferenceDto {
  @ApiProperty({ type: ActivityLocationDto }) location!: ActivityLocationDto;
  @ApiProperty({ enum: ['mentions', 'none'] }) level!: 'mentions' | 'none';
}

export class NotificationPreferenceListDto {
  @ApiProperty({ type: [NotificationPreferenceDto] }) data!: NotificationPreferenceDto[];
}
