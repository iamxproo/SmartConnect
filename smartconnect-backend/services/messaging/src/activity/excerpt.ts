// Activity excerpts: plain text of at most 200 characters. Markdown marks are dropped and whitespace collapsed.
// `<@userId>` mention tokens are KEPT for the client to resolve to names (the server does not know display names);
// the cut never lands inside a token.
export const EXCERPT_LENGTH = 200;

const TOKEN = /<@[0-9a-f-]{36}>/gi;
const MARKS = /[`*_~>#]/g;

export function excerptOf(body: string): string {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/(<@[0-9a-f-]{36}>)/i)
    .map((part, i) => (i % 2 ? part : part.replace(MARKS, '')))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= EXCERPT_LENGTH) return text;
  let end = EXCERPT_LENGTH - 1;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index < end && match.index + match[0].length > end) end = match.index;
  }
  return `${text.slice(0, end).trimEnd()}…`;
}
