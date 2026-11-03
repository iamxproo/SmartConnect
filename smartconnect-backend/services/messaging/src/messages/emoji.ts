// A reaction is ONE Unicode emoji sequence of at most 64 bytes: a pictograph with an optional variation selector or
// skin tone, ZWJ joins of those, a flag (two regional indicators), a keycap or a tag sequence (subdivision flags).
const PICTOGRAPH = String.raw`\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?`;
const EMOJI = new RegExp(
  String.raw`^(?:\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|[\u{E0020}-\u{E007E}]+\u{E007F})?(?:‍${PICTOGRAPH})*)$`,
  'u',
);

export const MAX_EMOJI_BYTES = 64;

export const isEmoji = (value: string): boolean => Buffer.byteLength(value) <= MAX_EMOJI_BYTES && EMOJI.test(value);
