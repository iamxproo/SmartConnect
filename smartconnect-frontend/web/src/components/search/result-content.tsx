import { Badge } from '@smartconnect/ui/components/badge';
import { Highlight } from './highlight';
import type { SearchItem } from './search-sources';

/** The inside of one result, shared by the palette and the search page. */
export function ResultContent({ item, query }: { item: SearchItem; query: string }) {
  const Icon = item.icon;
  const mode = item.matchWords ? 'terms' : 'phrase';
  return (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span
          className={item.wrapTitle ? 'block line-clamp-2 text-sm font-medium' : 'block truncate text-sm font-medium'}
        >
          <Highlight text={item.title} query={query} mode={mode} />
        </span>
        {item.subtitle ? (
          <span className="block truncate text-xs text-muted-foreground">
            {item.matchSubtitle ? <Highlight text={item.subtitle} query={query} mode={mode} /> : item.subtitle}
          </span>
        ) : null}
      </span>
      {item.badges?.map((badge) => (
        <Badge key={badge}>{badge}</Badge>
      ))}
    </>
  );
}
