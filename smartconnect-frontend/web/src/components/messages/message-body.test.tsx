import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageText } from './message-body';

const ID = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const names: Record<string, string> = { [ID]: 'Grace Hopper' };
const nameOf = (userId: string) => names[userId] ?? 'Former member';

const view = (body: string, selfId?: string) =>
  render(
    <MessageText nameOf={nameOf} selfId={selfId}>
      {body}
    </MessageText>,
  ).container;

describe('MessageText', () => {
  it('renders the Markdown subset as elements', () => {
    const root = view('**bold** _it_ ~~gone~~ `code`\n> quoted\n```\nblock\n```');
    expect(root.querySelector('strong')).toHaveTextContent('bold');
    expect(root.querySelector('em')).toHaveTextContent('it');
    expect(root.querySelector('s')).toHaveTextContent('gone');
    expect(root.querySelector('p code')).toHaveTextContent('code');
    expect(root.querySelector('blockquote')).toHaveTextContent('quoted');
    expect(root.querySelector('pre code')).toHaveTextContent('block');
  });

  it('opens http(s) links safely', () => {
    const link = view('see https://example.com/path.').querySelector('a')!;
    expect(link).toHaveAttribute('href', 'https://example.com/path');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('https://example.com/path');
  });

  it('shows mentions as chips with the name from the directory, and "Former member" for unknown people', () => {
    const root = view(`hi <@${ID}> and <@11111111-1111-4111-8111-111111111111>`);
    const chips = [...root.querySelectorAll('span')].map((chip) => chip.textContent);
    expect(chips).toEqual(['@Grace Hopper', '@Former member']);
    expect(root.textContent).not.toContain(ID);
  });

  it('marks mentions of the signed-in person', () => {
    const chip = view(`<@${ID}>`, ID).querySelector('span')!;
    expect(chip).toHaveClass('ring-1');
  });

  describe('hostile input', () => {
    it.each([
      ['a script tag', '<script>window.pwned = 1</script>'],
      ['an image with a handler', '<img src=x onerror="window.pwned = 1">'],
      ['an iframe', '<iframe src="javascript:alert(1)"></iframe>'],
      ['an anchor', '<a href="javascript:alert(1)">click</a>'],
      ['an svg', '<svg onload=alert(1)></svg>'],
    ])('keeps %s as text', (_name, body) => {
      const root = view(body);
      expect(root.querySelector('script, img, iframe, a, svg, [onerror], [onload]')).toBeNull();
      expect(root.textContent).toBe(body);
    });

    it.each([
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      '[click](javascript:alert(1))',
    ])('never makes a link of %s', (body) => {
      const root = view(body);
      expect(root.querySelector('a')).toBeNull();
      expect(root.textContent).toBe(body);
    });

    it('shows HTML inside code literally', () => {
      const root = view('`<b>x</b>`\n```\n<script>alert(1)</script>\n```');
      expect(root.querySelector('b, script')).toBeNull();
      expect(root.querySelector('p code')?.textContent).toBe('<b>x</b>');
      expect(root.querySelector('pre code')?.textContent).toBe('<script>alert(1)</script>');
    });

    it('does not interpret markup inside a link or a mention', () => {
      const root = view('https://example.com/<b>x</b>');
      expect(root.querySelector('b')).toBeNull();
    });

    it('never uses innerHTML-style rendering for message text', () => {
      const root = view('<b onclick="x()">hi</b>');
      expect(root.innerHTML).not.toContain('<b');
      expect(root.innerHTML).toContain('&lt;b onclick');
    });
  });
});
