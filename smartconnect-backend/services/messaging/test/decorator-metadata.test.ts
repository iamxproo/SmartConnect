// Guard: NestJS DI and the ValidationPipe read emitted design-time metadata. If Vitest's transform stopped emitting
// it, DTO validation would silently become a no-op in tests while still working in the tsc build.
import { describe, expect, it } from 'vitest';
import { AccessGuard } from '../src/access/access.guard.js';
import { ChannelDirectory } from '../src/channels/channel-directory.js';
import { PostMessageDto } from '../src/messages/dto.js';
import { MessagesController } from '../src/messages/messages.controller.js';
import { MessagesService } from '../src/messages/messages.service.js';

describe('decorator metadata', () => {
  it('records constructor and handler parameter types', () => {
    expect(Reflect.getMetadata('design:paramtypes', MessagesController)).toEqual([MessagesService]);
    expect(Reflect.getMetadata('design:paramtypes', ChannelDirectory)).toHaveLength(1);
    expect(Reflect.getMetadata('design:paramtypes', AccessGuard)).toHaveLength(4);
    const params = Reflect.getMetadata('design:paramtypes', MessagesController.prototype, 'post') as unknown[];
    expect(params[2]).toBe(PostMessageDto);
  });

  it('records property types', () => {
    expect(Reflect.getMetadata('design:type', PostMessageDto.prototype, 'body')).toBe(String);
    expect(Reflect.getMetadata('design:type', PostMessageDto.prototype, 'clientMessageId')).toBe(String);
  });
});
