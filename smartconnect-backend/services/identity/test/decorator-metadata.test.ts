// Guard: NestJS DI and the ValidationPipe read emitted design-time metadata. If Vitest's transform stopped emitting
// it, DTO validation would silently become a no-op in tests while still working in the tsc build.
import { describe, expect, it } from 'vitest';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthService } from '../src/auth/auth.service.js';
import { LoginDto, RegisterDto } from '../src/auth/dto.js';

describe('decorator metadata', () => {
  it('records constructor and handler parameter types', () => {
    expect(Reflect.getMetadata('design:paramtypes', AuthController)).toEqual([AuthService]);
    expect(Reflect.getMetadata('design:paramtypes', AuthController.prototype, 'register')).toEqual([RegisterDto]);
    expect((Reflect.getMetadata('design:paramtypes', AuthController.prototype, 'login') as unknown[])[0]).toBe(
      LoginDto,
    );
  });

  it('records property types', () => {
    expect(Reflect.getMetadata('design:type', RegisterDto.prototype, 'email')).toBe(String);
  });
});
