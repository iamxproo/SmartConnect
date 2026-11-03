// The safe Markdown subset of messages (ADR 0013): bold, italic, strikethrough, inline code, code blocks, quotes,
// auto-linked http(s) URLs and `<@USER_UUID>` mentions. This module only PARSES into a small tree; the renderer builds
// React elements from it, so no markup is ever interpreted as HTML and nothing here can produce a script or an
// unsafe URL scheme.

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'bold' | 'italic' | 'strike'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; text: string }
  | { type: 'mention'; userId: string };

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'code'; text: string; language: string | null };

// Sticky: matched at an exact position, so scanning a long body never copies it.
// Ids are UUIDs; the shape is not enforced here, because the server is what decides who can be mentioned.
const MENTION = /<@([\w-]{1,64})>/y;
/** A URL longer than this is not auto-linked. Matching is bounded by it, so no input makes a scan quadratic. */
export const MAX_URL_LENGTH = 2048;
const URL_AT_START = new RegExp(`https?://[^\\s<>]{1,${MAX_URL_LENGTH + 1}}`, 'iy');
const URL_TOKEN_CHAR = /[^\s<>]/y;
const TRAILING_PUNCTUATION = new Set('.,;:!?\'")]}');
/** Characters parsed per message; the rest is shown as plain text, so one hostile body costs bounded work. */
export const MAX_PARSED_CHARS = 20_000;
/** Nesting deeper than this is shown as text, so a hostile body cannot exhaust the stack. */
const MAX_DEPTH = 6;

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/** Only http and https destinations become links; the parsed URL's own spelling is what the link points to. */
export function safeHref(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Drops trailing punctuation by walking back from the end: linear, unlike an anchored `+$` regex. */
function trimTrailingPunctuation(url: string): string {
  let end = url.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(url[end - 1]!)) end--;
  return url.slice(0, end);
}

/** Where the non-space run that starts at `from` ends. */
function tokenEnd(source: string, from: number): number {
  URL_TOKEN_CHAR.lastIndex = from;
  let end = from;
  while (end < source.length && URL_TOKEN_CHAR.test(source)) {
    end++;
    URL_TOKEN_CHAR.lastIndex = end;
  }
  return end;
}

/**
 * What a link shows. The href is the validated URL; the label must not mislead: direction overrides, zero-width and
 * other invisible format/control characters are removed, and "user@" credentials (which make `https://bank.com@evil.test`
 * look like bank.com) are hidden.
 */
export function displayLinkText(raw: string): string {
  const visible = raw.replace(/[\p{Cf}\p{Cc}]/gu, '');
  return visible.replace(/^(https?:\/\/)[^/?#]*@/i, '$1');
}

function pushText(out: Inline[], text: string) {
  if (!text) return;
  const last = out.at(-1);
  if (last?.type === 'text') last.text += text;
  else out.push({ type: 'text', text });
}

export function parseInline(source: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;

    if (char === '<') {
      MENTION.lastIndex = i;
      const mention = MENTION.exec(source);
      if (mention) {
        out.push({ type: 'mention', userId: mention[1]!.toLowerCase() });
        i += mention[0].length;
        continue;
      }
    }
    if (char === '`') {
      const end = source.indexOf('`', i + 1);
      const code = end > i + 1 ? source.slice(i + 1, end) : '';
      if (code && !code.includes('\n')) {
        out.push({ type: 'code', text: code });
        i = end + 1;
        continue;
      }
    }
    if (char === 'h' || char === 'H') {
      URL_AT_START.lastIndex = i;
      const match = URL_AT_START.exec(source);
      if (match && !isWordChar(source[i - 1])) {
        if (match[0].length - match[0].indexOf('//') - 2 > MAX_URL_LENGTH) {
          // Too long to be a link: the whole token is text, skipped in one step.
          const end = tokenEnd(source, i);
          pushText(out, source.slice(i, end));
          i = end;
          continue;
        }
        const raw = trimTrailingPunctuation(match[0]);
        const href = safeHref(raw);
        if (href) {
          out.push({ type: 'link', href, text: displayLinkText(raw) });
          i += raw.length;
          continue;
        }
      }
    }
    if (depth < MAX_DEPTH) {
      const marker = source.startsWith('**', i)
        ? '**'
        : source.startsWith('~~', i)
          ? '~~'
          : char === '*' || char === '_'
            ? char
            : '';
      if (marker && (marker !== '_' || !isWordChar(source[i - 1]))) {
        const end = source.indexOf(marker, i + marker.length);
        const inner = end > 0 ? source.slice(i + marker.length, end) : '';
        // Not emphasis when empty or padded with spaces ("2 * 3 * 4"), and `_` must close at a word edge.
        const valid =
          inner !== '' &&
          !/^\s|\s$/.test(inner) &&
          !(marker === '_' && isWordChar(source[end + 1])) &&
          !(marker === '*' && source[end + 1] === '*');
        if (valid) {
          const type = marker === '**' ? 'bold' : marker === '~~' ? 'strike' : 'italic';
          out.push({ type, children: parseInline(inner, depth + 1) });
          i = end + marker.length;
          continue;
        }
      }
    }
    pushText(out, char);
    i += 1;
  }
  return out;
}

/** Blocks: fenced code, quote lines (`> `), and paragraphs (consecutive other lines; line breaks are kept). */
export function parseMessage(body: string): Block[] {
  if (body.length > MAX_PARSED_CHARS)
    return [
      ...parseMessage(body.slice(0, MAX_PARSED_CHARS)),
      { type: 'paragraph', children: [{ type: 'text', text: body.slice(MAX_PARSED_CHARS) }] },
    ];
  const blocks: Block[] = [];
  const lines = body.split('\n');
  let noMoreFences = false; // once a search for a closing fence fails, no later one can succeed
  let paragraph: string[] = [];
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };
  const flushQuote = () => {
    if (quote.length) blocks.push({ type: 'quote', children: parseInline(quote.join('\n')) });
    quote = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```([\w+-]{0,20})\s*$/.exec(line);
    if (fence && !noMoreFences) {
      const close = lines.indexOf('```', i + 1);
      if (close < 0) noMoreFences = true;
      if (close > i) {
        flushParagraph();
        flushQuote();
        blocks.push({ type: 'code', text: lines.slice(i + 1, close).join('\n'), language: fence[1] || null });
        i = close;
        continue;
      }
    }
    if (line.startsWith('> ')) {
      flushParagraph();
      quote.push(line.slice(2));
      continue;
    }
    flushQuote();
    paragraph.push(line);
  }
  flushParagraph();
  flushQuote();
  return blocks;
}

// ---- mentions in the composer: people see "@Name", the body carries "<@id>" ----

export interface Mentionable {
  userId: string;
  name: string;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Turns "@Name" for known people into `<@id>` tokens (longest names first, so "Ann Lee" wins over "Ann"). */
export function mentionsToTokens(text: string, people: readonly Mentionable[]): string {
  if (!text.includes('@')) return text;
  let result = text;
  for (const person of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const pattern = new RegExp(`(^|[\\s(\\[{>])@${escapeRegExp(person.name)}(?![\\p{L}\\p{N}_])`, 'gu');
    result = result.replace(pattern, (_match, before: string) => `${before}<@${person.userId}>`);
  }
  return result;
}

/** The reverse, for editing: known people read "@Name"; unknown ids stay as tokens. */
export function tokensToMentions(body: string, people: readonly Mentionable[]): string {
  const names = new Map(people.map((p) => [p.userId, p.name]));
  return body.replace(/<@([\w-]{1,64})>/g, (token, id: string) => {
    const name = names.get(id.toLowerCase());
    return name ? `@${name}` : token;
  });
}
