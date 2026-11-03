// Mentions: `<@USER_UUID>` tokens in the body. The server stores up to 50 distinct user mentions per message.
import { invalid } from '../common/errors.js';
import { UUID_PATTERN } from '../common/uuid.js';
import type { Prisma } from '../database/client.js';

export const MAX_MENTIONS = 50;

const TOKEN = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

/** The distinct, lower-cased user ids mentioned in the body, in order of appearance. Over the limit is a 422. */
export function parseMentions(body: string): string[] {
  const ids = new Set<string>();
  for (const [, id] of body.matchAll(TOKEN)) {
    if (UUID_PATTERN.test(id!)) ids.add(id!.toLowerCase());
  }
  if (ids.size > MAX_MENTIONS)
    throw invalid('body', 'too_many_mentions', `A message can mention at most ${MAX_MENTIONS} people.`);
  return [...ids];
}

export const notMentionable = () =>
  invalid('body', 'invalid_mention', 'Only people who can be reached in this conversation can be mentioned.');

/** Makes the stored mentions exactly `userIds` (insert the new ones, drop the removed ones). */
export async function syncMentions(
  tx: Prisma.TransactionClient,
  scope: { organizationId: string; conversationId: string; messageId: string },
  userIds: string[],
): Promise<void> {
  const { organizationId, conversationId, messageId } = scope;
  await tx.messageMention.deleteMany({
    where: { organizationId, messageId, kind: 'user', mentionedUserId: { notIn: userIds } },
  });
  if (userIds.length === 0) return;
  await tx.messageMention.createMany({
    data: userIds.map((mentionedUserId) => ({
      organizationId,
      conversationId,
      messageId,
      kind: 'user' as const,
      mentionedUserId,
    })),
    skipDuplicates: true,
  });
}
