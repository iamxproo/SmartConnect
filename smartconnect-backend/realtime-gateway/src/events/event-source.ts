// Where fan-out events come from. Production: a Redis pub/sub subscription. Tests inject an in-memory source.
import { createClient } from '@redis/client';

export interface EventSource {
  /** Starts delivering raw messages to `onMessage`. Resolves once subscribed. */
  start(onMessage: (raw: string) => void): Promise<void>;
  /** True while events can arrive (readiness). */
  isReady(): boolean;
  close(): Promise<void>;
}

/**
 * A dedicated subscriber connection (a connection in subscriber mode cannot run other commands). Every gateway
 * instance subscribes itself, so each event reaches the local sockets of ALL instances without a Socket.IO Redis
 * adapter. node-redis restores the subscription after a reconnect.
 */
export class RedisEventSource implements EventSource {
  private readonly client: ReturnType<typeof createClient>;
  private subscribed = false;

  constructor(
    url: string,
    private readonly channel: string,
  ) {
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: 2_000, reconnectStrategy: (retries) => Math.min(retries * 200, 2_000) },
    });
    // Without a listener, a connection error would crash the process; readiness reports the state.
    this.client.on('error', () => undefined);
  }

  async start(onMessage: (raw: string) => void): Promise<void> {
    await this.client.connect();
    await this.client.subscribe(this.channel, (message) => onMessage(message));
    this.subscribed = true;
  }

  isReady(): boolean {
    return this.subscribed && this.client.isReady;
  }

  async close(): Promise<void> {
    this.subscribed = false;
    if (!this.client.isOpen) return;
    if (this.client.isReady) await this.client.close();
    else this.client.destroy();
  }
}
