// Provisions the disposable test instance once per run: bootstrap → ephemeral role passwords →
// `prisma migrate deploy` for all 14 services as their migrator roles → privilege re-assertion.
// This is the same sequence production deployments run, so a green run also rehearses deployment.
import type { TestProject } from 'vitest/node';
import { isContainerRunning, loadTargets, provisionTestInstance } from '../../../infrastructure/scripts/lib/db-lib.mjs';
import type { ProvidedDb } from '../../support/database.js';

export default function setup(project: TestProject): void {
  const { test } = loadTargets();
  if (!isContainerRunning(test.container)) {
    throw new Error(`${test.container} is not running. Start it with: make test-db-up`);
  }
  const started = Date.now();
  const { services, target } = provisionTestInstance();
  console.log(`[database] test instance provisioned (bootstrap + 14 services migrated) in ${Date.now() - started} ms`);

  const db: ProvidedDb = {
    services,
    // provisionTestInstance() has already failed if the test admin password is missing.
    admin: {
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.adminUser,
      password: target.adminPassword!,
    },
  };
  project.provide('db', db);
}
