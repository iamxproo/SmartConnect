import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { RealtimePublisher } from '../src/events/realtime-publisher.js';
import { generateSigningKey } from './keys.js';

const { kty, crv, x, kid } = generateSigningKey('k1');
const base = {
  DATABASE_URL: 'postgresql://sc_messaging_app:pw@127.0.0.1:15433/smartconnect_test?schema=messaging',
  AUTH_JWT_PUBLIC_JWKS: JSON.stringify({ keys: [{ kty, crv, x, kid }] }),
};
const channel = { workspaceId: 'w', channelId: 'c' } as never;

describe('RealtimePublisher', () => {
  it('is a silent no-op when REDIS_URL is unset', () => {
    const publisher = new RealtimePublisher(loadConfig(base));
    publisher.onModuleInit();
    expect(() => publisher.publish('created', { organizationId: 'o' }, channel, 'm')).not.toThrow();
  });

  it('never throws when Redis is unreachable (the HTTP response must not change)', async () => {
    const publisher = new RealtimePublisher(loadConfig({ ...base, REDIS_URL: 'redis://127.0.0.1:1' }));
    publisher.onModuleInit();
    try {
      expect(() => publisher.publish('deleted', { organizationId: 'o' }, channel, 'm')).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await publisher.onApplicationShutdown();
    }
  });

  it('publishes conversation changes as id-only JSON, with distinct recipients', () => {
    const publisher = new RealtimePublisher(loadConfig({ ...base, REDIS_URL: 'redis://127.0.0.1:1' }));
    const published: string[][] = [];
    (publisher as unknown as { client: unknown }).client = {
      publish: (channel: string, message: string) => {
        published.push([channel, message]);
        return Promise.resolve(1);
      },
    };
    publisher.publishConversationChanged({
      change: 'message.created',
      organizationId: 'o',
      conversationId: 'c',
      messageId: 'm',
      recipientUserIds: ['u1', 'u2', 'u1'],
    });
    publisher.publishConversationChanged({
      change: 'conversation.updated',
      organizationId: 'o',
      conversationId: 'c',
      messageId: null,
      recipientUserIds: [],
    });
    expect(published).toHaveLength(1); // no recipients: nothing to publish
    expect(published[0]![0]).toBe('smartconnect:events');
    expect(JSON.parse(published[0]![1]!)).toEqual({
      service: 'messaging',
      type: 'conversation.changed',
      change: 'message.created',
      organizationId: 'o',
      conversationId: 'c',
      messageId: 'm',
      recipientUserIds: ['u1', 'u2'],
    });
  });
});
