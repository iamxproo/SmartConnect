import { Button } from '@smartconnect/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@smartconnect/ui/components/dialog';
import { Input } from '@smartconnect/ui/components/input';
import { cn } from '@smartconnect/ui/lib/utils';
import { Search } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { describeError } from '@/lib/api/messages';
import type { OrgSummary } from '@/lib/api/types';
import { MAX_QUERY_LENGTH, SEARCH_DEBOUNCE_MS, useSearch, useSearchActions } from '@/lib/queries/search';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { ResultContent } from './result-content';
import type { SearchItem } from './search-sources';

const PALETTE_LIMIT = 5;

interface Props {
  org: OrgSummary;
  open: boolean;
  /** Where focus goes back to when the palette closes without opening a result. */
  returnFocus: RefObject<HTMLElement | null>;
  /** `navigated`: a result was opened, so focus should stay on the page it led to. */
  onClose: (navigated: boolean) => void;
}

/** The command palette: a modal combobox over the search sources. Nothing typed here is remembered after it closes. */
export function SearchPalette({ org, open, returnFocus, onClose }: Props) {
  const navigated = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose(false);
      }}
    >
      <DialogContent
        aria-describedby="search-palette-hint"
        closeLabel="Close search"
        className="max-w-xl p-0"
        // Anchored below the top edge so the box does not jump as results come and go.
        style={{ top: '10dvh', bottom: 'auto', margin: '0 auto' }}
        onCloseAutoFocus={(event) => {
          // Radix returns focus to a DialogTrigger only; this palette has several ways in.
          event.preventDefault();
          if (!navigated.current) returnFocus.current?.focus();
          navigated.current = false;
        }}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription id="search-palette-hint" className="sr-only">
          Search people, channels, workspaces, messages and files. Use the up and down arrow keys to choose a result and
          Enter to open it.
        </DialogDescription>
        <PaletteBody
          org={org}
          onClose={(didNavigate) => {
            navigated.current = didNavigate;
            onClose(didNavigate);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

interface Option {
  item: SearchItem;
  id: string;
}

function PaletteBody({ org, onClose }: { org: OrgSummary; onClose: (navigated: boolean) => void }) {
  const listId = useId();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const activeRef = useRef<HTMLElement | null>(null);
  const trimmed = text.trim();
  const q = useDebouncedValue(trimmed, SEARCH_DEBOUNCE_MS);
  const sections = useSearch(org.id, q, PALETTE_LIMIT);
  const actions = useSearchActions(org);

  const groups = sections.map(({ source, query }) => ({ source, query, items: query.data?.items ?? [] }));
  const seeAll: SearchItem = {
    key: 'search-page',
    title: `Show all results for “${q}”`,
    icon: Search,
    open: ({ navigate, orgSlug }) =>
      navigate({ to: '/o/$orgSlugOrId/search', params: { orgSlugOrId: orgSlug }, search: { q } }),
  };
  // One flat list in display order drives the keyboard: the groups only add headings.
  let position = 0;
  const numbered = groups.map((group) => ({
    ...group,
    options: group.items.map((item): Option => ({ item, id: `${listId}-${position++}` })),
  }));
  const seeAllOption: Option | null = q ? { item: seeAll, id: `${listId}-${position++}` } : null;
  const options = [...numbered.flatMap((group) => group.options), ...(seeAllOption ? [seeAllOption] : [])];
  const current = Math.min(active, options.length - 1);
  const currentOption = options[current];

  const settling = trimmed !== q || (q !== '' && groups.some(({ query }) => query.isFetching && !query.isError));
  const failed = groups.filter(({ query }) => query.isError);
  const found = groups.reduce((sum, group) => sum + group.items.length, 0);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [current, found]);

  async function choose(option: Option) {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      await option.item.open(actions);
      onClose(true);
    } catch (failure) {
      setOpening(false);
      setOpenError(describeError(failure));
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (currentOption && !settling) void choose(currentOption);
    }
  }

  let status: string;
  if (!q && !trimmed) status = 'Type to search people, channels, messages and files.';
  else if (settling) status = 'Searching…';
  else if (found === 0 && failed.length === 0) status = `No results for “${q}”.`;
  else status = `${found} ${found === 1 ? 'result' : 'results'}.`;

  return (
    <div aria-busy={settling || opening}>
      <div className="relative border-b border-border p-3 pr-12">
        <Search
          className="pointer-events-none absolute top-1/2 left-6 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="text"
          role="combobox"
          aria-label="Search"
          aria-autocomplete="list"
          aria-expanded={options.length > 0}
          aria-controls={options.length > 0 ? listId : undefined}
          aria-activedescendant={currentOption?.id}
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_QUERY_LENGTH}
          placeholder="Search people, channels, messages and files"
          className="pl-9"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
            setOpenError(null);
          }}
          onKeyDown={onKeyDown}
        />
      </div>

      <div className="max-h-[60dvh] overflow-y-auto p-2">
        {options.length > 0 ? (
          <div id={listId} role="listbox" aria-label="Search results">
            {numbered.map(({ source, options: groupOptions }) =>
              groupOptions.length > 0 ? (
                <div key={source.id} role="group" aria-labelledby={`${listId}-${source.id}`}>
                  <div
                    id={`${listId}-${source.id}`}
                    className="px-2 pt-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                  >
                    {source.label}
                  </div>
                  {groupOptions.map((option) => renderOption(option))}
                </div>
              ) : null,
            )}
            {seeAllOption ? (
              <div role="group" aria-label="More">
                {renderOption(seeAllOption)}
              </div>
            ) : null}
          </div>
        ) : null}

        <p role="status" className={cn('px-2 py-3 text-sm text-muted-foreground', options.length > 0 && 'sr-only')}>
          {status}
        </p>
        {openError ? (
          <p role="alert" className="px-2 py-1 text-sm text-danger">
            {openError}
          </p>
        ) : null}
        {failed.map(({ source, query }) => (
          <div key={source.id} role="alert" className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
            <span className="text-danger">Couldn’t search {source.noun}.</span>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Try again
            </Button>
          </div>
        ))}
      </div>
    </div>
  );

  function renderOption(option: Option) {
    const selected = option.id === currentOption?.id;
    return (
      <div
        key={option.item.key}
        id={option.id}
        role="option"
        aria-selected={selected}
        ref={selected ? (element) => void (activeRef.current = element) : undefined}
        // Keep focus in the search box while pointing at, or clicking, an option.
        onMouseDown={(event) => event.preventDefault()}
        onMouseMove={() => setActive(options.indexOf(option))}
        onClick={() => void choose(option)}
        className={cn(
          'flex cursor-pointer items-center gap-3 rounded-md px-2 py-2',
          selected && 'bg-surface-hover',
          opening && 'cursor-progress opacity-70',
        )}
      >
        <ResultContent item={option.item} query={q} />
      </div>
    );
  }
}
