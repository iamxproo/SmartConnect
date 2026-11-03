import { describe, expect, it } from 'vitest';
import { MAX_MENTIONS, parseMentions } from '../src/messages/mentions.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('parseMentions', () => {
  it('finds tokens in order, lower-cased and de-duplicated', () => {
    const upper = id(1).replace('0000', 'ABCD').toUpperCase();
    expect(parseMentions(`hi <@${upper}> and <@${id(2)}> and again <@${upper.toLowerCase()}>`)).toEqual([
      upper.toLowerCase(),
      id(2),
    ]);
  });

  it('ignores anything that is not a whole token', () => {
    expect(parseMentions(`<@not-a-uuid> @${id(1)} <@${id(1)} <${id(1)}> <@ ${id(1)}>`)).toEqual([]);
  });

  it('accepts exactly the limit and rejects one more with a 422', () => {
    const tokens = (n: number) => Array.from({ length: n }, (_, i) => `<@${id(i)}>`).join(' ');
    expect(parseMentions(tokens(MAX_MENTIONS))).toHaveLength(MAX_MENTIONS);
    expect(() => parseMentions(tokens(MAX_MENTIONS + 1))).toThrow(expect.objectContaining({ status: 422 }) as Error);
  });
});
