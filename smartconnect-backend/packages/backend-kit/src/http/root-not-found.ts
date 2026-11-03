import { Inject, Injectable, type OnApplicationBootstrap, type Type } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Request, Response } from 'express';
import { buildProblem, sendProblem } from './problem-details.js';

/**
 * Nest answers unknown routes with a 404 problem only under the global prefix (/api/v1) and on the excluded health
 * paths; any other path (e.g. `/`, or `/docs` when docs are disabled) would fall through to Express's default HTML
 * page, which echoes the path. onApplicationBootstrap runs right after Nest registers its routes and router hooks,
 * so this handler lands last in the stack and only sees requests nothing else handled.
 *
 * Returns a provider class: `providers: [rootNotFoundHandler(config.errorTypeBaseUrl)]`.
 */
export function rootNotFoundHandler(errorTypeBaseUrl: string): Type<OnApplicationBootstrap> {
  @Injectable()
  class RootNotFoundHandler implements OnApplicationBootstrap {
    constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

    onApplicationBootstrap(): void {
      this.adapterHost.httpAdapter.use((req: Request, res: Response) => {
        sendProblem(res, buildProblem(req, errorTypeBaseUrl, 404));
      });
    }
  }
  return RootNotFoundHandler;
}
