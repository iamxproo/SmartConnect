import { describe, expect, it } from 'vitest';
import { withReaction } from './message-actions';

describe('withReaction', () => {
  const thumbs = { emoji: '👍', count: 2, reacted: false };

  it('adds a new reaction and counts onto an existing one', () => {
    expect(withReaction([], '🎉', true)).toEqual([{ emoji: '🎉', count: 1, reacted: true }]);
    expect(withReaction([thumbs], '👍', true)).toEqual([{ emoji: '👍', count: 3, reacted: true }]);
  });

  it('is idempotent in both directions', () => {
    const mine = { emoji: '👍', count: 2, reacted: true };
    expect(withReaction([mine], '👍', true)).toEqual([mine]);
    expect(withReaction([thumbs], '👍', false)).toEqual([thumbs]);
  });

  it('takes a reaction back and drops it when nobody is left', () => {
    expect(withReaction([{ emoji: '👍', count: 2, reacted: true }], '👍', false)).toEqual([
      { emoji: '👍', count: 1, reacted: false },
    ]);
    expect(withReaction([{ emoji: '👍', count: 1, reacted: true }], '👍', false)).toEqual([]);
  });
});
