import { describe, expect, it, vi } from 'vitest';
import { addReaction } from '../src/messages/message-store.js';

describe('addReaction', () => {
  it('answers 409 message_deleted when the locking read finds no live message (a delete committed first)', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const createMany = vi.fn();
    const tx = { $queryRaw: queryRaw, messageReaction: { createMany } };
    const actor = {
      organizationId: '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      userId: '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
    };

    await expect(addReaction(tx as never, actor, '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d', '👍')).rejects.toMatchObject({
      status: 409,
    });
    expect(createMany).not.toHaveBeenCalled();
    // The lock itself excludes deleted rows, so the check cannot be stale.
    expect((queryRaw.mock.calls[0]![0] as string[]).join('')).toContain('deleted_at IS NULL FOR UPDATE');
  });
});
