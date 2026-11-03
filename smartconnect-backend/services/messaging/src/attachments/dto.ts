import { ApiProperty } from '@nestjs/swagger';

export class AttachmentAccessDto {
  @ApiProperty({ format: 'uuid' }) fileId!: string;
}
