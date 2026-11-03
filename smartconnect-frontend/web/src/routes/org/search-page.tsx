import { Button } from '@smartconnect/ui/components/button';
import { Input } from '@smartconnect/ui/components/input';
import { Skeleton } from '@smartconnect/ui/components/skeleton';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AtSign, FileIcon, Hash, Search, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChipPicker } from '@/components/search/chip-picker';
import type { OpenableFile } from '@/components/search/open-file';
import { ResultContent } from '@/components/search/result-content';
import {
  chipKey,
  chipLabel,
  filtersOf,
  hasFilters,
  hasModifiers,
  parseModifiers,
  resolveModifiers,
  withChip,
  type Chip,
  type SearchFilters,
} from '@/components/search/search-query';
import { searchSources, type SearchItem, type SearchSource } from '@/components/search/search-sources';
import { ImagePreviewDialog } from '@/components/files/image-preview-dialog';
import { PageContainer, PageHeader } from '@/components/page';
import { EmptyState } from '@/components/states/empty-state';
import { describeError } from '@/lib/api/messages';
import type { StoredFile } from '@/lib/api/types';
import { useRequiredOrg } from '@/lib/queries/orgs';
import { MAX_QUERY_LENGTH, SEARCH_DEBOUNCE_MS, useSearchActions, useSearchSection } from '@/lib/queries/search';
import { useApi } from '@/lib/services';

const PAGE_LIMIT = 20;

const asStoredFile = (file: OpenableFile): StoredFile => ({
  ...file,
  status: 'available',
  uploadedByUserId: '',
  createdAt: '',
  updatedAt: '',
});

/**
 * `/o/$org/search?q=`: the same sources as the palette, as sections with room for more results. Modifiers typed in the
 * box (from:@name in:#channel before:YYYY-MM-DD after:YYYY-MM-DD has:file) become removable chips, which narrow the
 * message and file sources; the address holds only the words that are searched.
 */
export function SearchPage() {
  const org = useRequiredOrg();
  const api = useApi();
  const navigate = useNavigate();
  const urlQuery = useSearch({ strict: false }).q?.trim() ?? '';
  const [text, setText] = useState(urlQuery);
  const textRef = useRef(text);
  // The last address this page wrote itself; any other change (back, forward, a link) replaces the text.
  const written = useRef(urlQuery);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const results = useRef<HTMLDivElement>(null);
  const [chips, setChips] = useState<Chip[]>([]);
  const [picker, setPicker] = useState<'from' | 'in' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<StoredFile | null>(null);
  const actions = useSearchActions(org, (file) => setPreviewing(asStoredFile(file)));

  // Words that are searched: never a modifier, typed or pending.
  const q = parseModifiers(urlQuery).text;
  const filters = filtersOf(chips);
  const sources = hasFilters(filters) ? searchSources.filter((source) => source.filterable) : searchSources;

  useEffect(() => {
    if (urlQuery === written.current) return;
    written.current = urlQuery;
    setText(urlQuery);
    textRef.current = urlQuery;
  }, [urlQuery]);
  useEffect(() => () => clearTimeout(timer.current), []);

  function show(value: string) {
    setText(value);
    textRef.current = value;
  }

  function writeAddress(value: string) {
    const next = parseModifiers(value).text;
    written.current = next;
    void navigate({ to: '.', search: { q: next || undefined }, replace: true });
  }

  /** Turns the modifiers in `value` into chips; names that match nobody stay in the text. */
  async function absorb(value: string) {
    const parsed = parseModifiers(value);
    if (!hasModifiers(parsed)) return;
    try {
      const { chips: found, unresolved } = await resolveModifiers(api, org.id, parsed);
      setChips((current) => found.reduce(withChip, current));
      setNotice(
        unresolved.length > 0
          ? `No single match for ${unresolved.join(' and ')}. Pick one with the filters below.`
          : null,
      );
      if (textRef.current === value) {
        const rest = [parsed.text, ...unresolved].join(' ').trim();
        show(rest && /\s$/.test(value) ? `${rest} ` : rest);
        writeAddress(parsed.text);
      }
    } catch (failure) {
      setNotice(`Couldn’t look up the filter. ${describeError(failure)}`);
    }
  }

  // A link or the palette can bring modifiers in the address: they become chips once.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- state is set after the lookup resolves, not here
    if (hasModifiers(parseModifiers(urlQuery))) void absorb(urlQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onChange(value: string) {
    show(value);
    clearTimeout(timer.current);
    // A finished word (a trailing space) may complete a modifier.
    if (/\s$/.test(value)) void absorb(value);
    timer.current = setTimeout(() => writeAddress(value), SEARCH_DEBOUNCE_MS);
  }

  async function open(item: SearchItem) {
    if (opening) return;
    setOpening(true);
    setOpenError(null);
    try {
      await item.open(actions);
    } catch (failure) {
      setOpenError(describeError(failure));
    } finally {
      setOpening(false);
    }
  }

  function addChip(chip: Chip) {
    setChips((current) => withChip(current, chip));
    setPicker(null);
  }

  /** Arrow keys walk the results (and back to the box); Tab still reaches everything. */
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const buttons = [...(results.current?.querySelectorAll<HTMLElement>('[data-search-result]') ?? [])];
    const from = buttons.indexOf(document.activeElement as HTMLElement);
    if (from === -1 && event.key === 'ArrowUp') return;
    event.preventDefault();
    const next = from + (event.key === 'ArrowDown' ? 1 : -1);
    if (next < 0) document.querySelector<HTMLElement>('[data-search-input]')?.focus();
    else buttons[Math.min(next, buttons.length - 1)]?.focus();
  }

  return (
    <PageContainer>
      <PageHeader
        title="Search"
        description="People, channels, workspaces, messages and files you can see in this organization."
      />
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          clearTimeout(timer.current);
          writeAddress(text);
          void absorb(text);
        }}
        onKeyDown={onKeyDown}
      >
        <Input
          type="search"
          data-search-input
          aria-label="Search this organization"
          aria-describedby="search-modifier-help"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAX_QUERY_LENGTH}
          placeholder="Search, or add from:@name in:#channel before:2026-01-31 has:file"
          value={text}
          onChange={(event) => onChange(event.target.value)}
        />
        <p id="search-modifier-help" className="sr-only">
          Type from:@name, in:#channel, before:YYYY-MM-DD, after:YYYY-MM-DD or has:file, then a space, to add a filter.
          Use the down arrow to move into the results.
        </p>
      </form>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        {chips.map((chip) => (
          <button
            key={chipKey(chip)}
            type="button"
            aria-label={`Remove filter ${chipLabel(chip)}`}
            onClick={() => setChips((current) => current.filter((existing) => chipKey(existing) !== chipKey(chip)))}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-selected px-2.5 py-1 text-xs font-medium hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {chipLabel(chip)}
            <X className="size-3" aria-hidden="true" />
          </button>
        ))}
        <Button
          variant="outline"
          size="sm"
          aria-expanded={picker === 'from'}
          onClick={() => setPicker(picker === 'from' ? null : 'from')}
        >
          <AtSign aria-hidden="true" /> From…
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={picker === 'in'}
          onClick={() => setPicker(picker === 'in' ? null : 'in')}
        >
          <Hash aria-hidden="true" /> In…
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={chips.some((chip) => chip.kind === 'file')}
          onClick={() =>
            setChips((current) =>
              current.some((chip) => chip.kind === 'file')
                ? current.filter((chip) => chip.kind !== 'file')
                : withChip(current, { kind: 'file' }),
            )
          }
        >
          <FileIcon aria-hidden="true" /> Has file
        </Button>
      </div>
      {picker ? <ChipPicker kind={picker} orgId={org.id} onPick={addChip} onClose={() => setPicker(null)} /> : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {openError ? (
        <p role="alert" className="text-sm text-danger">
          {openError}
        </p>
      ) : null}

      <div ref={results} onKeyDown={onKeyDown} className="flex flex-col gap-6">
        {q === '' ? (
          <EmptyState
            icon={Search}
            title="Search your organization"
            description={
              hasFilters(filters)
                ? 'Add words to search for within these filters.'
                : 'Type a name, a word or a file name to find people, channels, workspaces, messages and files.'
            }
          />
        ) : (
          sources.map((source) => (
            <Section
              key={source.id}
              source={source}
              orgId={org.id}
              q={q}
              filters={filters}
              opening={opening}
              onOpen={open}
            />
          ))
        )}
      </div>
      <ImagePreviewDialog orgId={org.id} file={previewing} onClose={() => setPreviewing(null)} />
    </PageContainer>
  );
}

function Section({
  source,
  orgId,
  q,
  filters,
  opening,
  onOpen,
}: {
  source: SearchSource;
  orgId: string;
  q: string;
  filters: SearchFilters;
  opening: boolean;
  onOpen: (item: SearchItem) => Promise<void>;
}) {
  const query = useSearchSection(source, orgId, q, filters, PAGE_LIMIT);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section aria-labelledby={`search-${source.id}`} className="flex flex-col gap-2">
      <h3 id={`search-${source.id}`} className="text-sm font-semibold">
        {source.label}
        {query.data ? (
          <span className="font-normal text-muted-foreground">
            {' '}
            · {items.length}
            {query.hasNextPage ? '+' : ''}
          </span>
        ) : null}
      </h3>
      {query.isError && !query.data ? (
        <div role="alert" className="flex items-center justify-between gap-2 text-sm">
          <span className="text-danger">
            Couldn’t search {source.noun}. {describeError(query.error)}
          </span>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </div>
      ) : query.isPending ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Searching {source.noun}…</span>
          <Skeleton className="h-10 w-full" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No {source.noun} match “{q}”.
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  data-search-result
                  disabled={opening}
                  onClick={() => void onOpen(item)}
                  className="flex w-full items-center gap-3 rounded-md border border-border px-3 py-2 text-left hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-70"
                >
                  <ResultContent item={item} query={q} />
                </button>
              </li>
            ))}
          </ul>
          {query.isError ? (
            <p role="alert" className="text-sm text-danger">
              Couldn’t load more {source.noun}. {describeError(query.error)}
            </p>
          ) : null}
          {query.hasNextPage ? (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : `Load more ${source.noun}`}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
