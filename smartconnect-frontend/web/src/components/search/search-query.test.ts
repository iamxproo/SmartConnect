import { describe, expect, it } from 'vitest';
import {
  chipLabel,
  filtersOf,
  parseModifiers,
  queryTerms,
  resolveModifiers,
  snippetOf,
  withChip,
  type Chip,
} from './search-query';

describe('parseModifiers', () => {
  it('extracts every modifier and leaves the words', () => {
    expect(parseModifiers('budget from:@ada in:#general before:2026-05-01 after:2026-01-15 has:file report')).toEqual({
      text: 'budget report',
      from: 'ada',
      channel: 'general',
      before: '2026-05-01',
      after: '2026-01-15',
      hasFile: true,
    });
  });

  it('accepts quoted names and ignores case of the keywords', () => {
    expect(parseModifiers('FROM:@"Ada Lovelace" Has:File x')).toMatchObject({
      from: 'Ada Lovelace',
      hasFile: true,
      text: 'x',
    });
  });

  it('keeps malformed or embedded modifiers as text', () => {
    for (const text of [
      'before:2026-02-31',
      'after:yesterday',
      'from:ada',
      'in:general',
      'has:image',
      'xfrom:@ada',
      'a-has:file',
    ]) {
      expect(parseModifiers(text)).toMatchObject({ text, hasFile: false });
      expect(parseModifiers(text).from).toBeUndefined();
    }
  });

  it('lets the last of a kind win and collapses whitespace', () => {
    expect(parseModifiers('  a   from:@x  b from:@y ')).toMatchObject({ text: 'a b', from: 'y' });
  });
});

describe('chips', () => {
  const chips: Chip[] = [
    { kind: 'from', userId: 'u1', label: 'Ada' },
    { kind: 'in', channelId: 'c1', label: 'general' },
    { kind: 'before', date: '2026-05-01' },
    { kind: 'file' },
  ];

  it('turns into query filters and readable labels', () => {
    expect(filtersOf(chips)).toEqual({ from: 'u1', channelId: 'c1', before: '2026-05-01', hasFile: true });
    expect(chips.map(chipLabel)).toEqual(['from: Ada', 'in: #general', 'before: 2026-05-01', 'has: file']);
  });

  it('replaces a chip of the same kind', () => {
    const next = withChip(chips, { kind: 'from', userId: 'u2', label: 'Grace' });
    expect(next.filter((chip) => chip.kind === 'from')).toEqual([{ kind: 'from', userId: 'u2', label: 'Grace' }]);
    expect(next).toHaveLength(4);
  });
});

describe('resolveModifiers', () => {
  const api = (people: unknown[], channels: unknown[] = []) =>
    ({
      get: (path: string) => Promise.resolve({ data: path.endsWith('/members') ? people : channels }),
    }) as never;
  const parsed = (text: string) => parseModifiers(text);

  it('resolves an exact or single match, and reports the rest', async () => {
    const ada = { userId: 'u1', displayName: 'Ada Lovelace', email: 'ada@example.com' };
    const adam = { userId: 'u2', displayName: 'Adam Smith', email: 'adam@example.com' };
    expect((await resolveModifiers(api([ada]), 'o', parsed('from:@ad'))).chips).toEqual([
      { kind: 'from', userId: 'u1', label: 'Ada Lovelace' },
    ]);
    expect((await resolveModifiers(api([ada, adam]), 'o', parsed('from:@ada'))).chips).toEqual([
      { kind: 'from', userId: 'u1', label: 'Ada Lovelace' },
    ]);
    const ambiguous = await resolveModifiers(api([ada, adam]), 'o', parsed('from:@ad'));
    expect(ambiguous).toEqual({ chips: [], unresolved: ['from:@ad'] });
    const none = await resolveModifiers(api([], []), 'o', parsed('in:#"no such" before:2026-01-01'));
    expect(none).toEqual({ chips: [{ kind: 'before', date: '2026-01-01' }], unresolved: ['in:#"no such"'] });
    expect((await resolveModifiers(api([], [{ id: 'c1', name: 'general' }]), 'o', parsed('in:#gen'))).chips).toEqual([
      { kind: 'in', channelId: 'c1', label: 'general' },
    ]);
  });
});

describe('query terms and snippets', () => {
  it('keeps phrases whole and drops operators', () => {
    expect(queryTerms('"launch plan" budget -draft or ship')).toEqual(['launch plan', 'budget', 'ship']);
  });

  it('centres the excerpt on the first match and makes mentions readable', () => {
    const body = `${'lorem '.repeat(60)}needle ${'ipsum '.repeat(60)}`;
    const snippet = snippetOf(body, ['needle']);
    expect(snippet.length).toBeLessThanOrEqual(162);
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippetOf('hi <@0f8fad5b-d9cb-469f-a165-70867728950e> there', [])).toBe('hi @mention there');
  });
});
