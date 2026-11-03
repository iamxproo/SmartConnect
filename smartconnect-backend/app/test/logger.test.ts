import { Logger } from '@nestjs/common';
import { createJsonLogger, logLevels } from '@smartconnect/backend-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppLogger, resetStaticLogger } from '../src/logger.js';

const lines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

afterEach(() => resetStaticLogger('log'));

describe('AppLogger', () => {
  it("enables exactly the levels of the kit's JSON logger", () => {
    for (const level of logLevels) {
      const kit = createJsonLogger(level);
      const app = new AppLogger('identity', level);
      for (const candidate of logLevels)
        expect(app.isLevelEnabled(candidate), `${level}/${candidate}`).toBe(kit.isLevelEnabled(candidate));
    }
  });

  it('writes the same JSON line as the kit logger, plus the application name', () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    new AppLogger('organization', 'log').log({ event: 'http_request', status: 200 }, 'HTTP');
    createJsonLogger('log').log({ event: 'http_request', status: 200 }, 'HTTP');
    const [tagged, plain] = lines(out);
    expect(tagged).toMatchObject({
      level: 'log',
      context: 'HTTP',
      message: { event: 'http_request', status: 200 },
      app: 'organization',
    });
    expect(
      Object.keys(tagged!)
        .filter((k) => k !== 'app')
        .sort(),
    ).toEqual(Object.keys(plain!).sort());
  });

  it("points Nest's process-wide logger at an untagged JSON logger, so no line names the wrong application", () => {
    Logger.overrideLogger(new AppLogger('gateway', 'log'));
    resetStaticLogger('log');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    new Logger('ServiceClient').warn({ event: 'dependency_failed' });
    const [line] = lines(out);
    expect(line).toMatchObject({ context: 'ServiceClient', message: { event: 'dependency_failed' } });
    expect(line).not.toHaveProperty('app');
  });
});
