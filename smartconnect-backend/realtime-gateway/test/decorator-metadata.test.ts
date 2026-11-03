// Guard: NestJS dependency injection reads TypeScript's emitted design-time metadata. If Vitest's transform
// (vitest.config.ts → Oxc) stopped emitting it, injected dependencies would be silently undefined in tests.
import { describe, expect, it } from 'vitest';
import { ChannelDirectory } from '../src/realtime/channel-directory.js';
import { RealtimeHub } from '../src/realtime/hub.js';

describe('decorator metadata', () => {
  it('records constructor parameter types', () => {
    expect(Reflect.getMetadata('design:paramtypes', ChannelDirectory)).toHaveLength(1);
    expect(Reflect.getMetadata('design:paramtypes', RealtimeHub)).toHaveLength(6);
  });
});
