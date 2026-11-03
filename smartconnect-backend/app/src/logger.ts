// Logging in one process for seven applications. Each application gets its own instance of the kit's JSON logger
// (createJsonLogger: same format, same levels) that also writes an `app` field, so request logs and error-filter logs
// say which application wrote them: the gateway and a service both log the same request path.
//
// Nest's static `Logger` (the `new Logger(context)` used inside services) is process-wide, and every NestFactory.create
// points it at the logger of the application being created. The backend points it back at an untagged logger right
// after each application is created, so those lines carry no `app` field rather than a wrong one; their context
// (`UpstreamProxy`, `ServiceClient`, …) still identifies them.
import { ConsoleLogger, Logger, type LogLevel as NestLogLevel } from '@nestjs/common';
import { createJsonLogger, type LogLevel } from '@smartconnect/backend-kit';

/** Most to least severe, as in the kit's createJsonLogger: a level enables itself and everything more severe. */
const SEVERITY: NestLogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

export const levelsFor = (level: LogLevel): NestLogLevel[] => SEVERITY.slice(0, SEVERITY.indexOf(level) + 1);

/** The options parameter of ConsoleLogger.getJsonLogObject (@nestjs/common 12.2.0). */
interface JsonLogOptions {
  context: string;
  logLevel: NestLogLevel;
  writeStreamType?: 'stdout' | 'stderr';
  errorStack?: unknown;
  params?: Record<string, unknown>;
  error?: Error;
}

export class AppLogger extends ConsoleLogger {
  constructor(
    readonly app: string,
    level: LogLevel,
  ) {
    super({ json: true, colors: false, logLevels: levelsFor(level) });
  }

  protected override getJsonLogObject(message: unknown, options: JsonLogOptions) {
    return { ...super.getJsonLogObject(message, options), app: this.app };
  }
}

/** Nest's static logger back to an untagged JSON logger (see above). */
export function resetStaticLogger(level: LogLevel): void {
  Logger.overrideLogger(createJsonLogger(level));
}
