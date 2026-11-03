// Interim fan-out (ADR 0004): after a message change COMMITS, an id-only event is published to Redis pub/sub for the
// realtime gateway. The outbox row (events/outbox.ts) is still written in the transaction; this is the low-latency
// copy. Delivery is best effort: a failure is logged and never affects the HTTP response (clients refetch on
// reconnect). Message bodies never enter an event.
import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { createClient } from '@redis/client';
import type { ChannelAccess } from '../channels/channel-directory.js';
import { MESSAGING_CONFIG, type MessagingConfig } from '../config.js';

export type RealtimeChange = 'created' | 'updated' | 'deleted';

export type ConversationChange =
  'message.created' | 'message.updated' | 'message.deleted' | 'conversation.updated' | 'read';

/** Inbox event for direct and group conversations. Ids only; `recipientUserIds` is consumed by the gateway. */
export interface ConversationChanged {
  change: ConversationChange;
  organizationId: string;
  conversationId: string;
  /** The message for message changes and for `read` (the new cursor); null for `conversation.updated`. */
  messageId: string | null;
  recipientUserIds: string[];
}

/** The gateway accepts at most this many recipients per event. */
export const MAX_RECIPIENTS = 100;

@Injectable()
export class RealtimePublisher implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('RealtimePublisher');
  private client: ReturnType<typeof createClient> | undefined;

  constructor(@Inject(MESSAGING_CONFIG) private readonly config: MessagingConfig) {}

  onModuleInit(): void {
    const { redisUrl } = this.config.realtime;
    if (redisUrl === undefined) {
      this.logger.log({ event: 'realtime_publishing_disabled', reason: 'REDIS_URL is not set' });
      return;
    }
    this.client = createClient({
      url: redisUrl,
      // Fail fast instead of queueing while disconnected: a publish must never delay a request.
      disableOfflineQueue: true,
      commandOptions: { timeout: 1_000 },
      socket: { connectTimeout: 2_000, reconnectStrategy: (retries) => Math.min(retries * 200, 2_000) },
    });
    // Without a listener, a connection error would crash the process; publish failures are logged per event.
    this.client.on('error', () => undefined);
    // Not awaited: the client keeps (re)connecting in the background.
    this.client.connect().catch(() => undefined);
  }

  /** Fire and forget; never throws. Call only after the transaction has committed. */
  publish(type: RealtimeChange, actor: { organizationId: string }, channel: ChannelAccess, messageId: string): void {
    const client = this.client;
    if (!client) return;
    const message = JSON.stringify({
      service: 'messaging',
      type: `message.${type}`,
      organizationId: actor.organizationId,
      workspaceId: channel.workspaceId,
      channelId: channel.channelId,
      messageId,
    });
    client.publish(this.config.realtime.eventsChannel, message).catch((error: unknown) => {
      this.logger.warn({ event: 'realtime_publish_failed', type, error: (error as Error).message });
    });
  }

  /** Fire and forget; never throws. Call only after the transaction has committed. */
  publishConversationChanged(event: ConversationChanged): void {
    const client = this.client;
    const recipientUserIds = [...new Set(event.recipientUserIds)].slice(0, MAX_RECIPIENTS);
    if (!client || recipientUserIds.length === 0) return;
    const message = JSON.stringify({ service: 'messaging', type: 'conversation.changed', ...event, recipientUserIds });
    client.publish(this.config.realtime.eventsChannel, message).catch((error: unknown) => {
      this.logger.warn({
        event: 'realtime_publish_failed',
        type: 'conversation.changed',
        error: (error as Error).message,
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    const client = this.client;
    if (!client?.isOpen) return;
    if (client.isReady) await client.close();
    else client.destroy();
  }
}
