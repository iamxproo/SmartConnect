import { describe, expect, it } from 'vitest';
import { isEmoji } from '../src/messages/emoji.js';

describe('isEmoji', () => {
  it.each([
    ['simple', '👍'],
    ['with variation selector', '❤️'],
    ['with skin tone', '👍🏽'],
    ['ZWJ family', '👨‍👩‍👧‍👦'],
    ['flag', '🇮🇳'],
    ['keycap', '1️⃣'],
    ['subdivision flag', '🏴󠁧󠁢󠁥󠁮󠁧󠁿'],
  ])('accepts %s', (_name, value) => {
    expect(isEmoji(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['text', 'a'],
    ['digit', '1'],
    ['two emoji', '👍👍'],
    ['emoji and text', '👍a'],
    ['shortcode', ':thumbsup:'],
    ['markup', '<b>👍</b>'],
    ['newline', '👍\n'],
    ['dangling ZWJ', '👍‍'],
    ['combining mark', '👍́'],
    ['too many bytes', '👨‍👩‍👧‍👦'.repeat(2)],
  ])('rejects %s', (_name, value) => {
    expect(isEmoji(value)).toBe(false);
  });

  it('rejects a sequence over 64 bytes even when every part is an emoji', () => {
    const long = Array.from({ length: 8 }, () => '👍').join('‍'); // 8 x 4 bytes + 7 x 3 bytes = 53
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(64);
    expect(isEmoji(long)).toBe(true);
    const longer = Array.from({ length: 12 }, () => '👍').join('‍');
    expect(Buffer.byteLength(longer)).toBeGreaterThan(64);
    expect(isEmoji(longer)).toBe(false);
  });
});
