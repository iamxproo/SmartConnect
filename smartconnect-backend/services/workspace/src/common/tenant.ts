import type { Prisma } from '../database/client.js';

/** The caller within one organization: both ids come from the verified token and the checked path, never the body. */
export interface Actor {
  organizationId: string;
  userId: string;
}

/**
 * Serialises membership changes of one workspace / channel (last-admin checks must not race). Taken before any read
 * the decision depends on; READ COMMITTED then shows the other transaction's committed changes.
 */
export async function lockWorkspace(tx: Prisma.TransactionClient, actor: Actor, workspaceId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "workspace"."workspaces"
                     WHERE id = ${workspaceId}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
}

export async function lockChannel(tx: Prisma.TransactionClient, actor: Actor, channelId: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "workspace"."channels"
                     WHERE id = ${channelId}::uuid AND organization_id = ${actor.organizationId}::uuid FOR UPDATE`;
}
