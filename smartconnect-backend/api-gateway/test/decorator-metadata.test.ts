// Guard: NestJS dependency injection and ValidationPipe read TypeScript's emitted design-time metadata. If the
// test transform (vitest.config.ts → Oxc) stopped emitting it, DTO validation would silently become a no-op in
// tests while still working in the tsc build. This fails loudly instead.
import { describe, expect, it } from 'vitest';
import { UpstreamProxy } from '../src/proxy/upstream-proxy.js';
import { RateLimitGuard } from '../src/rate-limit/rate-limit.js';
import { AuthRoutesController } from '../src/routes/auth-routes.controller.js';
import { ProbeController, ProbeDto, ProbeNestedDto } from './support/probe.module.js';

// Classes from @smartconnect/backend-kit are compiled by tsc; these are compiled by Vitest's transform, which is
// what this guard is about.
describe('decorator metadata', () => {
  it('records constructor parameter types', () => {
    expect(Reflect.getMetadata('design:paramtypes', AuthRoutesController)).toEqual([UpstreamProxy]);
    expect(Reflect.getMetadata('design:paramtypes', RateLimitGuard)).toHaveLength(2);
  });

  it('records handler parameter types (ValidationPipe uses them to pick the DTO)', () => {
    expect(Reflect.getMetadata('design:paramtypes', ProbeController.prototype, 'echo')).toEqual([ProbeDto]);
  });

  it('records property types', () => {
    expect(Reflect.getMetadata('design:type', ProbeDto.prototype, 'name')).toBe(String);
    expect(Reflect.getMetadata('design:type', ProbeDto.prototype, 'nested')).toBe(ProbeNestedDto);
  });
});
