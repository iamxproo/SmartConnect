// Entry point of the unified backend (ADR 0016, Phase 1): the API gateway, realtime gateway and five services in one
// Node.js process, on one public port. The per-service start commands remain; this process and those cannot run at
// the same time on the same ports, which the port check reports before anything starts.
//
// Exit codes: 0 after a clean shutdown; 1 for a configuration problem, a busy port, a failed start (everything that
// was started is closed again), a shutdown that failed or overran its deadline, or a second termination signal.
import 'reflect-metadata';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { prepareBackend, startBackend, type Backend } from './backend.js';
import type { Env } from './env.js';
import { createSignalHandler } from './lifecycle.js';
import { findBusyPorts } from './ports.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const readEnvFile = (file: string): Env | undefined =>
  existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : undefined;

const { plan, problems } = prepareBackend(process.env, { repoRoot, readEnvFile });
if (!plan) {
  console.error(`Invalid unified backend configuration; nothing was started:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

const busy = await findBusyPorts(plan.ports);
if (busy.length > 0) {
  console.error(
    'Unified backend not started: ports already in use. Nothing was started and no other process was touched ' +
      `(stop the per-service processes first):\n  - ${busy.map((b) => `${b.app}: ${b.host}:${b.port} (${b.reason})`).join('\n  - ')}`,
  );
  process.exit(1);
}

let backend: Backend;
try {
  backend = await startBackend(plan);
} catch {
  // Logged by startBackend, which has already closed everything it started.
  process.exit(1);
}

// One handler for the whole process (the hosted applications do not install their own): the first signal starts the
// ordered shutdown; a duplicate delivery of it is ignored; a later, second signal exits at once.
const stop = createSignalHandler(
  () => backend.close().then((result) => (result.timedOut || result.failed.length > 0 ? 1 : 0)),
  (code) => process.exit(code),
  { onForced: (signal) => console.error(`Second ${signal}: exiting without waiting for the shutdown to finish.`) },
);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
