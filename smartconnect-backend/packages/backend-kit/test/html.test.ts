import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../src/email/html.js';

describe('escapeHtml', () => {
  it('escapes &, <, >, " and \'', () => {
    expect(escapeHtml(`Tom & Jerry's <b>"Co"</b>`)).toBe('Tom &amp; Jerry&#39;s &lt;b&gt;&quot;Co&quot;&lt;/b&gt;');
  });

  it('neutralizes markup and attribute breakouts from user-provided names', () => {
    const name = `"><img src=x onerror=alert(1)>`;
    const html = `<a title="${escapeHtml(name)}">${escapeHtml(name)}</a>`;
    expect(html).toBe(
      '<a title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</a>',
    );
    expect(html).not.toContain('<img');
  });

  it('escapes an existing entity again (no double-decoding tricks) and never links URLs', () => {
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
    expect(escapeHtml('Visit https://evil.example/reset')).toBe('Visit https://evil.example/reset');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeHtml('Acme Corporation — Engineering')).toBe('Acme Corporation — Engineering');
    expect(escapeHtml('')).toBe('');
  });
});
