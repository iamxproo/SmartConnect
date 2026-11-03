// Guard: NestJS DI and the ValidationPipe read emitted design-time metadata. If Vitest's transform stopped emitting
// it, DTO validation would silently become a no-op in tests while still working in the tsc build.
import { describe, expect, it } from 'vitest';
import { CreateChannelDto } from '../src/channels/dto.js';
import { ChannelsController } from '../src/channels/channels.controller.js';
import { ChannelsService } from '../src/channels/channels.service.js';
import { CreateWorkspaceDto } from '../src/workspaces/dto.js';
import { WorkspacesController } from '../src/workspaces/workspaces.controller.js';
import { WorkspacesService } from '../src/workspaces/workspaces.service.js';

describe('decorator metadata', () => {
  it('records constructor and handler parameter types', () => {
    expect(Reflect.getMetadata('design:paramtypes', WorkspacesController)).toEqual([WorkspacesService]);
    expect(Reflect.getMetadata('design:paramtypes', ChannelsController)).toEqual([ChannelsService]);
    const params = Reflect.getMetadata('design:paramtypes', WorkspacesController.prototype, 'create') as unknown[];
    expect(params[2]).toBe(CreateWorkspaceDto);
  });

  it('records property types', () => {
    expect(Reflect.getMetadata('design:type', CreateWorkspaceDto.prototype, 'slug')).toBe(String);
    expect(Reflect.getMetadata('design:type', CreateChannelDto.prototype, 'name')).toBe(String);
  });
});
