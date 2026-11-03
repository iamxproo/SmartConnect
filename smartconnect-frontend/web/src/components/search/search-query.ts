import type { ApiClient } from '@/lib/api/client';
import type { Member, Page } from '@/lib/api/types';

// The search box understands a few modifiers typed as text (from:@name, in:#channel, before:YYYY-MM-DD,
// after:YYYY-MM-DD, has:file). They become removable chips; only the remaining words are searched.

/** What the message and file sources can filter by (the query parameters of `GET /orgs/{o}/message-search`). */
export interface SearchFilters {
  from?: string;
  channelId?: string;
  before?: string;
  after?: string;
  hasFile?: boolean;
}

export const hasFilters = (filters: SearchFilters): boolean =>
  Boolean(filters.from || filters.channelId || filters.before || filters.after || filters.hasFile);

export type Chip =
  | { kind: 'from'; userId: string; label: string }
  | { kind: 'in'; channelId: string; label: string }
  | { kind: 'before'; date: string }
  | { kind: 'after'; date: string }
  | { kind: 'file' };

export const chipKey = (chip: Chip): string => chip.kind;

export function chipLabel(chip: Chip): string {
  switch (chip.kind) {
    case 'from':
      return `from: ${chip.label}`;
    case 'in':
      return `in: #${chip.label}`;
    case 'before':
    case 'after':
      return `${chip.kind}: ${chip.date}`;
    case 'file':
      return 'has: file';
  }
}

export function filtersOf(chips: readonly Chip[]): SearchFilters {
  const filters: SearchFilters = {};
  for (const chip of chips) {
    if (chip.kind === 'from') filters.from = chip.userId;
    else if (chip.kind === 'in') filters.channelId = chip.channelId;
    else if (chip.kind === 'before') filters.before = chip.date;
    else if (chip.kind === 'after') filters.after = chip.date;
    else filters.hasFile = true;
  }
  return filters;
}

/** Adds a chip, replacing the one of the same kind (there is one person, one channel and one date range end). */
export const withChip = (chips: readonly Chip[], chip: Chip): Chip[] => [
  ...chips.filter((existing) => chipKey(existing) !== chipKey(chip)),
  chip,
];

export interface ParsedModifiers {
  /** The text with every recognized modifier removed. */
  text: string;
  /** Names still to be resolved to a person or channel. */
  from?: string;
  channel?: string;
  before?: string;
  after?: string;
  hasFile: boolean;
}

const MODIFIER =
  /(^|\s)(?:from:@("[^"]+"|[^\s"]+)|in:#("[^"]+"|[^\s"]+)|before:(\d{4}-\d{2}-\d{2})|after:(\d{4}-\d{2}-\d{2})|(has:file))(?=\s|$)/gi;

const validDate = (value: string): boolean => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
};
const unquote = (value: string): string => value.replace(/^"|"$/g, '');

/** Pulls the modifiers out of typed text. Anything malformed (an impossible date, an empty name) stays as text. */
export function parseModifiers(input: string): ParsedModifiers {
  const found: ParsedModifiers = { text: '', hasFile: false };
  const text = input.replace(
    MODIFIER,
    (whole, lead: string, from?: string, channel?: string, before?: string, after?: string, file?: string) => {
      if (from) found.from = unquote(from);
      else if (channel) found.channel = unquote(channel);
      else if (before && validDate(before)) found.before = before;
      else if (after && validDate(after)) found.after = after;
      else if (file) found.hasFile = true;
      else return whole;
      return lead;
    },
  );
  found.text = text.replace(/\s+/g, ' ').trim();
  return found;
}

export const hasModifiers = (parsed: ParsedModifiers): boolean =>
  Boolean(parsed.from || parsed.channel || parsed.before || parsed.after || parsed.hasFile);

/** The words to highlight: quoted phrases stay whole, `-excluded` words and `or` are not matches. */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const [, phrase, word] of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    if (phrase) terms.add(phrase.trim());
    else if (word && !word.startsWith('-') && word.toLowerCase() !== 'or') terms.add(word.replace(/^"+|"+$/g, ''));
  }
  return [...terms].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** A plain-text excerpt of a message around the first match, with mention tokens made readable. */
export function snippetOf(body: string, terms: readonly string[], max = 160): string {
  const flat = body
    .replace(/<@[0-9a-f-]{36}>/gi, '@mention')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  const hits = terms.map((term) => lower.indexOf(term.toLowerCase())).filter((index) => index >= 0);
  const first = hits.length > 0 ? Math.min(...hits) : 0;
  const start = Math.max(0, Math.min(first - 40, flat.length - max));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + max)}${start + max < flat.length ? '…' : ''}`;
}

/** Names of the people and channels the chips refer to are looked up through the existing searches. */
export interface Resolution {
  chips: Chip[];
  /** Typed modifiers that matched nobody (or several people); they are put back in the text. */
  unresolved: string[];
}

interface ChannelHit {
  id: string;
  name: string;
}

function pick<T>(hits: T[], names: (hit: T) => string[], wanted: string): T | undefined {
  const lower = wanted.toLowerCase();
  const exact = hits.filter((hit) => names(hit).some((name) => name.toLowerCase() === lower));
  if (exact.length === 1) return exact[0];
  return exact.length === 0 && hits.length === 1 ? hits[0] : undefined;
}

export async function resolveModifiers(
  api: ApiClient,
  orgId: string,
  parsed: ParsedModifiers,
  signal?: AbortSignal,
): Promise<Resolution> {
  const chips: Chip[] = [];
  const unresolved: string[] = [];
  if (parsed.before) chips.push({ kind: 'before', date: parsed.before });
  if (parsed.after) chips.push({ kind: 'after', date: parsed.after });
  if (parsed.hasFile) chips.push({ kind: 'file' });
  if (parsed.from) {
    const page = await api.get<Page<Member>>(`/orgs/${orgId}/members`, { q: parsed.from, limit: 10 }, signal);
    const person = pick(page.data, (m) => [m.displayName, m.email.split('@')[0] ?? ''], parsed.from);
    if (person) chips.push({ kind: 'from', userId: person.userId, label: person.displayName });
    else unresolved.push(`from:@${/\s/.test(parsed.from) ? `"${parsed.from}"` : parsed.from}`);
  }
  if (parsed.channel) {
    const page = await api.get<Page<ChannelHit>>(`/orgs/${orgId}/channels`, { q: parsed.channel, limit: 10 }, signal);
    const channel = pick(page.data, (c) => [c.name], parsed.channel);
    if (channel) chips.push({ kind: 'in', channelId: channel.id, label: channel.name });
    else unresolved.push(`in:#${/\s/.test(parsed.channel) ? `"${parsed.channel}"` : parsed.channel}`);
  }
  return { chips, unresolved };
}
