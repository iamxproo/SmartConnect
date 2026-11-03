import { queryTerms } from './search-query';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `text` with the occurrences of `query` marked. Built from React elements, so the text is never parsed as HTML.
 * `phrase` (default) marks the whole query; `terms` marks each word of a message search, as the search matches words.
 */
export function Highlight({
  text,
  query,
  mode = 'phrase',
}: {
  text: string;
  query: string;
  mode?: 'phrase' | 'terms';
}) {
  const needles = mode === 'terms' ? queryTerms(query) : [query.trim()].filter(Boolean);
  if (needles.length === 0) return text;
  // A capture group makes split() keep the matches, at the odd positions.
  const parts = text.split(new RegExp(`(${needles.map(escapeRegExp).join('|')})`, 'i'));
  return parts.map((part, index) =>
    index % 2 === 1 ? (
      <mark key={index} className="rounded-xs bg-primary/15 font-semibold text-inherit">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
