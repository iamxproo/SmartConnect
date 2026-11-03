// Guard: NestJS DI and the ValidationPipe read emitted design-time metadata (see vitest.config.ts).
import { describe, expect, it } from 'vitest';
import { CreateFileDto } from '../src/files/dto.js';
import { FilesController } from '../src/files/files.controller.js';
import { FilesService } from '../src/files/files.service.js';

describe('decorator metadata', () => {
  it('records constructor and handler parameter types', () => {
    expect(Reflect.getMetadata('design:paramtypes', FilesController)).toEqual([FilesService]);
    const params = Reflect.getMetadata('design:paramtypes', FilesController.prototype, 'create') as unknown[];
    expect(params[2]).toBe(CreateFileDto);
  });

  it('records property types', () => {
    expect(Reflect.getMetadata('design:type', CreateFileDto.prototype, 'name')).toBe(String);
    expect(Reflect.getMetadata('design:type', CreateFileDto.prototype, 'sizeBytes')).toBe(Number);
  });
});
