import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/guard.js';
import { ApiProblemException } from '../http/problem-details.js';
import { ApiProblemResponses } from '../openapi/decorators.js';

/** A dependency the service cannot serve traffic without (e.g. its database). Throws or rejects when unavailable. */
export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

/** Optional provider: `{ provide: READINESS_CHECKS, useFactory: (...) => ReadinessCheck[] }`. */
export const READINESS_CHECKS = Symbol('READINESS_CHECKS');

const CHECK_TIMEOUT_MS = 2_000;

/** Ready only between a completed bootstrap and the start of shutdown (so load balancers drain traffic first). */
@Injectable()
export class ReadinessState implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Lifecycle');
  private ready = false;

  onApplicationBootstrap(): void {
    this.ready = true;
  }

  beforeApplicationShutdown(signal?: string): void {
    this.ready = false;
    this.logger.log({ event: 'service_stopping', signal: signal ?? null });
  }

  isReady(): boolean {
    return this.ready;
  }
}

export class LivenessDto {
  @ApiProperty({ enum: ['ok'], example: 'ok' })
  status!: 'ok';
}

export class ReadinessDto {
  @ApiProperty({ enum: ['ready'], example: 'ready' })
  status!: 'ready';
}

async function withTimeout(check: ReadinessCheck): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check.check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS} ms`)), CHECK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Infrastructure probes. Deliberately reveal nothing about versions, dependencies or configuration: a failing
 * dependency check is logged server-side and answered with the same generic 503 as startup and shutdown.
 */
@ApiTags('Health')
@Public()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger('Health');

  constructor(
    @Inject(ReadinessState) private readonly readiness: ReadinessState,
    @Optional() @Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[] = [],
  ) {}

  @Get('live')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Liveness: the process is running' })
  @ApiOkResponse({ type: LivenessDto })
  live(): LivenessDto {
    return { status: 'ok' };
  }

  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Readiness: accepting traffic (false while starting, shutting down or degraded)' })
  @ApiOkResponse({ type: ReadinessDto })
  @ApiProblemResponses(503)
  async ready(): Promise<ReadinessDto> {
    const notReady = new ApiProblemException(503, 'not_ready', 'The service is not accepting traffic right now.');
    if (!this.readiness.isReady()) throw notReady;
    for (const check of this.checks) {
      try {
        await withTimeout(check);
      } catch (error) {
        this.logger.warn({ event: 'readiness_check_failed', check: check.name, error: (error as Error).message });
        throw notReady;
      }
    }
    return { status: 'ready' };
  }
}
