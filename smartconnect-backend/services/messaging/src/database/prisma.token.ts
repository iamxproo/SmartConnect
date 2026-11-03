import type { createPrismaClient } from './client.js';

/** Injection token for the service's PrismaClient (constructed only by createPrismaClient()). */
export const PRISMA = Symbol('PRISMA');

export type MessagingPrisma = ReturnType<typeof createPrismaClient>;
