import { describe, expect, it } from 'vitest';
import {
  mentionsToTokens,
  parseInline,
  parseMessage,
  safeHref,
  tokensToMentions,
  type Inline,
  type Mentionable,
} from './message-format';

const ID = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const text = (value: string): Inline => ({ type: 'text', text: value });

describe('parseInline', () => {
  it('parses bold, italic, strikethrough and inline code', () => {
    expect(parseInline('a **b** _c_ *d* ~~e~~ `f`')).toEqual([
      text('a '),
      { type: 'bold', children: [text('b')] },
      text(' '),
      { type: 'italic', children: [text('c')] },
      text(' '),
      { type: 'italic', children: [text('d')] },
      text(' '),
      { type: 'strike', children: [text('e')] },
      text(' '),
      { type: 'code', text: 'f' },
    ]);
  });

  it('nests emphasis, and leaves markup inside code alone', () => {
    expect(parseInline('**a _b_**')).toEqual([
      { type: 'bold', children: [text('a '), { type: 'italic', children: [text('b')] }] },
    ]);
    expect(parseInline('`**not bold**`')).toEqual([{ type: 'code', text: '**not bold**' }]);
  });

  it('keeps markers that do not form emphasis as plain text', () => {
    for (const plain of ['2 * 3 * 4', 'snake_case_name', 'a ** b', '**', 'unclosed **bold', '`open']) {
      expect(parseInline(plain)).toEqual([text(plain)]);
    }
  });

  it('turns http(s) URLs into links without trailing punctuation', () => {
    expect(parseInline('see https://example.com/a?b=1, or (http://x.test/y).')).toEqual([
      text('see '),
      { type: 'link', href: 'https://example.com/a?b=1', text: 'https://example.com/a?b=1' },
      text(', or ('),
      { type: 'link', href: 'http://x.test/y', text: 'http://x.test/y' },
      text(').'),
    ]);
  });

  it('never links other schemes, whatever their spelling', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'file:///etc/passwd',
      'ftp://example.com',
      '//evil.example',
      'xhttps://example.com',
    ]) {
      expect(
        parseInline(hostile).every((node) => node.type !== 'link'),
        hostile,
      ).toBe(true);
    }
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('https://ok.example/x')).toBe('https://ok.example/x');
  });

  it('parses mention tokens, lower-cased, and ignores malformed ones', () => {
    expect(parseInline(`hi <@${ID.toUpperCase()}>!`)).toEqual([
      text('hi '),
      { type: 'mention', userId: ID },
      text('!'),
    ]);
    expect(parseInline('<@> <@a b> <@x.y> <@>')).toEqual([text('<@> <@a b> <@x.y> <@>')]);
  });

  it('keeps HTML as literal text', () => {
    expect(parseInline('<script>alert(1)</script><img src=x onerror=alert(1)>')).toEqual([
      text('<script>alert(1)</script><img src=x onerror=alert(1)>'),
    ]);
  });

  it('survives hostile input: deep nesting, many markers, and a very long body', () => {
    expect(() => parseInline('*_'.repeat(5000) + 'x' + '_*'.repeat(5000))).not.toThrow();
    const started = performance.now();
    parseInline('*a '.repeat(13_000));
    parseInline('**'.repeat(20_000));
    parseInline(`<@${ID}`.repeat(4000));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('parseMessage', () => {
  it('keeps plain text as one paragraph with its line breaks', () => {
    expect(parseMessage('one\n\ntwo')).toEqual([{ type: 'paragraph', children: [text('one\n\ntwo')] }]);
  });

  it('separates quotes and fenced code, and never parses inside code blocks', () => {
    const blocks = parseMessage('before\n> quoted **x**\n> more\n```ts\nconst a = "<b>**no**</b>";\n```\nafter');
    expect(blocks).toEqual([
      { type: 'paragraph', children: [text('before')] },
      { type: 'quote', children: [text('quoted '), { type: 'bold', children: [text('x')] }, text('\nmore')] },
      { type: 'code', language: 'ts', text: 'const a = "<b>**no**</b>";' },
      { type: 'paragraph', children: [text('after')] },
    ]);
  });

  it('treats an unclosed fence as text', () => {
    expect(parseMessage('```\nnot closed')).toEqual([{ type: 'paragraph', children: [text('```\nnot closed')] }]);
  });
});

describe('mention text conversion', () => {
  const people: Mentionable[] = [
    { userId: ID, name: 'Ann Lee' },
    { userId: '11111111-1111-4111-8111-111111111111', name: 'Ann' },
  ];

  it('turns @Name into tokens, preferring the longest name', () => {
    expect(mentionsToTokens('hi @Ann Lee and @Ann, bye', people)).toBe(
      `hi <@${ID}> and <@11111111-1111-4111-8111-111111111111>, bye`,
    );
  });

  it('only converts at a word start and not inside longer words', () => {
    expect(mentionsToTokens('mail@Ann and @Annabel', people)).toBe('mail@Ann and @Annabel');
  });

  it('is the inverse of tokensToMentions for known people and leaves unknown ids alone', () => {
    const unknown = '<@22222222-2222-4222-8222-222222222222>';
    expect(tokensToMentions(`<@${ID}> ${unknown}`, people)).toBe(`@Ann Lee ${unknown}`);
    expect(mentionsToTokens(tokensToMentions(`x <@${ID}>`, people), people)).toBe(`x <@${ID}>`);
  });

  it('treats regex characters in names literally', () => {
    const odd = [{ userId: ID, name: 'A.B (x)' }];
    expect(mentionsToTokens('hey @A.B (x)!', odd)).toBe(`hey <@${ID}>!`);
    expect(mentionsToTokens('hey @AxB (x)!', odd)).toBe('hey @AxB (x)!');
  });
});

describe('link display text', () => {
  const linkOf = (body: string) => parseInline(body).find((node) => node.type === 'link');

  it('strips bidi, zero-width and control characters from the label, keeping the validated href', () => {
    const link = linkOf('see https://example.com/\u202Egnp.\u200Bpath\u0007 now');
    expect(link).toMatchObject({ type: 'link', text: 'https://example.com/gnp.path' });
    expect((link as { href: string }).href).toMatch(/^https:\/\/example\.com\/%E2%80%AE/);
  });

  it('hides user@ credentials in the label so a trusted-looking prefix cannot disguise the host', () => {
    const link = linkOf('https://bank.com@evil.test/login');
    expect(link).toMatchObject({ href: 'https://bank.com@evil.test/login', text: 'https://evil.test/login' });
    expect(linkOf('http://user:pa55@host.test')).toMatchObject({ text: 'http://host.test' });
    expect(linkOf('https://a.test/path?next=x@y')).toMatchObject({ text: 'https://a.test/path?next=x@y' });
  });
});

describe('bounded work on hostile input', () => {
  const fast = (build: () => string, ms = 50) => {
    const body = build();
    const started = performance.now();
    parseMessage(body);
    expect(performance.now() - started).toBeLessThan(ms);
  };

  it('a URL followed by 39,000 closing brackets', () => fast(() => 'http://a' + ')'.repeat(39_000)));
  it('"http://[" repeated', () => fast(() => 'http://['.repeat(5_000)));
  it('"http://" repeated without spaces', () => fast(() => 'http://'.repeat(5_000)));
  it('a 100,000 character URL', () => fast(() => 'https://a.test/' + 'x'.repeat(100_000)));
  it('unclosed code fences with a language, one per line', () => fast(() => '```js\n'.repeat(4_000)));
  it('unclosed emphasis markers and backticks', () => {
    fast(() => '*a '.repeat(6_000));
    fast(() => '`a\n'.repeat(6_000));
    fast(() => '_a b '.repeat(4_000));
  });
  it('deeply nested emphasis', () => fast(() => '**_~~'.repeat(2_000) + 'x'));

  it('does not auto-link a URL over 2,048 characters, and links the one at the limit', () => {
    const long = 'https://a.test/' + 'x'.repeat(2_100);
    expect(parseInline(`${long} ok`)).toEqual([text(`${long} ok`)]);
    const edge = 'https://a.test/' + 'x'.repeat(2_048 - 'a.test/'.length);
    expect(parseInline(edge)[0]).toMatchObject({ type: 'link' });
  });

  it('shows what is past the parsing budget as plain text', () => {
    const blocks = parseMessage('**a** ' + 'x'.repeat(30_000) + ' **b**');
    expect(blocks.at(-1)).toMatchObject({ type: 'paragraph' });
    const tail = (blocks.at(-1) as { children: Inline[] }).children;
    expect(tail).toEqual([text(expect.stringContaining('**b**') as unknown as string)]);
  });
});
