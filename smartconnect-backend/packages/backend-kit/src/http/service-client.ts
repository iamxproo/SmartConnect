// Synchronous reads of another service's data through its API (docs/database/architecture.md#communication-rules).
// The CALLER'S OWN access token is forwarded, so the other service authenticates and authorizes the end user itself:
// a service can never learn more through this client than its caller could ask directly.
import { Logger } from '@nestjs/common';
import type { Request } from 'express';
import { ApiProblemException } from './problem-details.js';
import { REQUEST_ID_HEADER, requestIdOf } from './request-context.js';

/** The caller outside an HTTP request (e.g. a WebSocket): its access token and a correlation id. */
export interface CallerCredentials {
  authorization: string;
  requestId: string;
}

export interface ServiceResponse<T> {
  status: number;
  /** Parsed JSON body (2xx) or undefined. */
  body: T | undefined;
}

export class ServiceClient {
  private readonly logger = new Logger('ServiceClient');

  constructor(
    private readonly service: string,
    private readonly baseUrl: string,
    private readonly timeoutMs = 5_000,
  ) {}

  /**
   * GET `path` (e.g. `/api/v1/orgs/{id}/me`) as the caller of `req`. Non-2xx statuses are returned for the caller to
   * interpret (404 = not visible to this user). Network failures and timeouts become 503: the dependency is down,
   * and the request must not proceed as if access had been granted.
   */
  async get<T>(path: string, caller: Request | CallerCredentials): Promise<ServiceResponse<T>> {
    const fromRequest = 'get' in caller;
    const requestId = fromRequest ? requestIdOf(caller) : caller.requestId;
    const authorization = fromRequest ? caller.get('authorization') : caller.authorization;
    const headers = new Headers({ accept: 'application/json', [REQUEST_ID_HEADER]: requestId });
    if (authorization) headers.set('authorization', authorization);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = res.ok ? ((await res.json()) as T) : undefined;
      if (!res.ok) await res.body?.cancel();
      return { status: res.status, body };
    } catch (error) {
      this.logger.warn({
        event: 'dependency_failed',
        service: this.service,
        requestId,
        error: (error as Error).message,
      });
      throw new ApiProblemException(503, 'dependency_unavailable', 'A required service is temporarily unavailable.');
    }
  }
}
