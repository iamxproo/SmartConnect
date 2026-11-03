import { ConsoleLogger, type LogLevel as NestLogLevel } from '@nestjs/common';
import type { LogLevel } from './config/env.js';

/** Most to least severe; a configured level enables itself and everything more severe. */
const SEVERITY: NestLogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

/** Structured JSON logs (one object per line) via Nest's built-in logger: no extra logging dependency. */
export function createJsonLogger(level: LogLevel): ConsoleLogger {
  return new ConsoleLogger({
    json: true,
    colors: false,
    logLevels: SEVERITY.slice(0, SEVERITY.indexOf(level) + 1),
  });
}
