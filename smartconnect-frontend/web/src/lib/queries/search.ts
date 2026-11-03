import { useInfiniteQuery, useQueries } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { downloadFile, type OpenableFile } from '@/components/search/open-file';
import type { SearchFilters } from '@/components/search/search-query';
import {
  searchSources,
  type SearchActions,
  type SearchPage,
  type SearchSource,
} from '@/components/search/search-sources';
import { useUser } from '@/lib/auth';
import type { OrgSummary } from '@/lib/api/types';
import { isPreviewableImage } from '@/lib/file-format';
import { useApi } from '@/lib/services';
import { useStartDirect } from './conversations';

export const SEARCH_DEBOUNCE_MS = 250;
export const MAX_QUERY_LENGTH = 100;

const NO_FILTERS: SearchFilters = {};

/**
 * One query per source, so a slow or failing source never blocks the others. Search terms are personal: the cache
 * entry lives only while the results are on screen (gcTime 0), and nothing is written to web storage.
 */
export function useSearch(orgId: string, q: string, limit: number) {
  const api = useApi();
  const selfUserId = useUser().id;
  const results = useQueries({
    queries: searchSources.map((source) => ({
      queryKey: ['orgs', orgId, 'search', source.id, source.paletteLimit ?? limit, q],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        source.search({ api, orgId, q, limit: source.paletteLimit ?? limit, filters: NO_FILTERS, selfUserId, signal }),
      enabled: q !== '',
      retry: false,
      gcTime: 0,
      staleTime: 0,
      refetchOnWindowFocus: false,
    })),
  });
  return searchSources.map((source, index) => ({ source, query: results[index]! }));
}

/** One source on the search page: the first page, then more on request (the source's own cursor). */
export function useSearchSection(
  source: SearchSource,
  orgId: string,
  q: string,
  filters: SearchFilters,
  limit: number,
) {
  const api = useApi();
  const selfUserId = useUser().id;
  return useInfiniteQuery({
    queryKey: ['orgs', orgId, 'search', source.id, 'page', limit, q, filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }): Promise<SearchPage> =>
      source.search({ api, orgId, q, limit, cursor: pageParam, filters, selfUserId, signal }),
    getNextPageParam: (last) => last.nextCursor,
    enabled: q !== '',
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}

/** `onPreview` shows an image in place; without it (the palette) every file is downloaded. */
export function useSearchActions(org: OrgSummary, onPreview?: (file: OpenableFile) => void): SearchActions {
  const navigate = useNavigate();
  const api = useApi();
  const start = useStartDirect(org.id);
  return {
    orgSlug: org.slug,
    navigate,
    startDirect: (userId) => start.mutateAsync(userId),
    openFile: async (file) => {
      if (onPreview && isPreviewableImage(file.mimeType)) onPreview(file);
      else await downloadFile(api, org.id, file);
    },
  };
}
