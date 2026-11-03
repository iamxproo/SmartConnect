import { describe, expect, it } from 'vitest';
import { formatUtcDateTime, renderEmail, type EmailContent } from '../src/email/layout.js';

const HOSTILE = `<script>alert("x")</script> & 'q'`;
const ESCAPED = '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;';
const URL_ = 'https://app.example.com/verify-email#token=abc_DEF-123';
const base: EmailContent = {
  subject: 'Verify your SmartConnect email address',
  preheader: 'Confirm it is you',
  heading: 'Confirm your email',
  paragraphs: ['Welcome to SmartConnect.', 'This link works once.'],
  action: { label: 'Verify email', url: URL_ },
  note: 'If you did not ask for this, ignore it.',
};

describe('renderEmail', () => {
  it('renders branded, table-based HTML with a button and a link fallback', () => {
    const { html, subject } = renderEmail(base);
    expect(subject).toBe(base.subject);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('max-width:560px');
    expect(html).toContain('>SmartConnect</td>');
    expect(html).toContain('<table role="presentation"');
    expect(html).toContain(`<a href="${URL_}"`);
    expect(html).toContain('>Verify email</a>');
    expect(html).toContain(`If the button does not work, copy this link: <span`);
    expect(html.match(new RegExp(URL_, 'g'))).toHaveLength(2);
    expect(html).toContain('You are receiving this email because of activity on your SmartConnect account.');
    expect(html).not.toMatch(/<img|<script|<link|<iframe|url\(/i);
  });

  it('uses the invitation footer on request', () => {
    const { html, text } = renderEmail({ ...base, footer: 'invitation' });
    expect(html).toContain('because someone invited you to join an organization on SmartConnect');
    expect(html).not.toContain('activity on your SmartConnect account');
    expect(text).toContain('someone invited you');
  });

  it('escapes every text value in every field', () => {
    const { html } = renderEmail({
      subject: HOSTILE,
      preheader: HOSTILE,
      heading: HOSTILE,
      paragraphs: [HOSTILE, HOSTILE],
      action: { label: HOSTILE, url: 'https://app.example.com/a?x="><script>alert(1)</script>&y=1' },
      note: HOSTILE,
    });
    expect(html).not.toContain('<script');
    expect(html).not.toContain(HOSTILE);
    expect(html.split(ESCAPED).length - 1).toBeGreaterThanOrEqual(7);
    expect(html).toContain('&amp;y=1');
    expect(html).not.toContain('?x="');
  });

  it('refuses action URLs that are not http(s)', () => {
    for (const url of [
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      '/relative',
      'not a url',
      '',
    ])
      expect(() => renderEmail({ ...base, action: { label: 'x', url } })).toThrow('http(s)');
    expect(() =>
      renderEmail({ ...base, action: { label: 'x', url: 'http://127.0.0.1:5173/x#token=1' } }),
    ).not.toThrow();
  });

  it('writes a plain-text twin with the raw URL on its own line', () => {
    const { text } = renderEmail(base);
    expect(text).toContain('Confirm your email');
    expect(text).toContain('Welcome to SmartConnect.');
    expect(text.split('\n')).toContain(URL_);
    expect(text).toContain('If you did not ask for this, ignore it.');
    expect(text).toContain('You are receiving this email because of activity on your SmartConnect account.');
    expect(text).not.toMatch(/<[a-z]/);
  });

  it('works without an action or note', () => {
    const { html, text } = renderEmail({ subject: 's', preheader: 'p', heading: 'h', paragraphs: ['one'] });
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('copy this link');
    expect(text).toContain('one');
  });

  it('has no remote images or tracking', () => {
    const { html } = renderEmail(base);
    expect(html).not.toMatch(/src=|background-image|@import/i);
    expect(html.match(/https?:\/\//g)).toHaveLength(2); // the button and the fallback, nothing else
  });
});

describe('formatUtcDateTime', () => {
  it('names the moment in UTC, whatever the local zone', () => {
    expect(formatUtcDateTime(new Date('2026-11-03T15:48:59Z'))).toMatch(/^3 November 2026 at 15:48 UTC$/);
    expect(formatUtcDateTime(new Date('2026-01-05T00:05:00Z'))).toMatch(/^5 January 2026 at 00:05 UTC$/);
  });
});
