import type { useNavigate } from '@tanstack/react-router';
import { Boxes, File as FileIcon, Hash, Lock, MessageSquare, UserRound, type LucideIcon } from 'lucide-react';
import type { ApiClient } from '@/lib/api/client';
import type { Conversation, Member, Page, StoredFile, Workspace } from '@/lib/api/types';
import { formatBytes, typeLabel } from '@/lib/file-format';
import { formatRelative } from '@/lib/relative-time';
import type { OpenableFile } from './open-file';
import { hasFilters, queryTerms, snippetOf, type SearchFilters } from './search-query';

// Global search is federated (ADR 0013, decision 3): every source asks the service that owns the data, which
// authorizes the caller itself. A source is one entry in `searchSources`; the palette and the search page render
// whatever the list holds. Wave 2 adds Messages and Files by appending a source here, with no change to either UI.

/** What a result may do when opened. */
export interface SearchActions {
  orgSlug: string;
  navigate: ReturnType<typeof useNavigate>;
  /** Starts (or reopens) the direct conversation with a person. */
  startDirect: (userId: string) => Promise<Conversation>;
  /** Previews an image or downloads any other file. */
  openFile: (file: OpenableFile) => Promise<unknown>;
}

export interface SearchItem {
  key: string;
  title: string;
  subtitle?: string;
  /** Whether the subtitle is part of what was matched (and so highlighted). */
  matchSubtitle?: boolean;
  badges?: string[];
  /** Highlight each word of the query (message search), not the query as one phrase. */
  matchWords?: boolean;
  /** The title is a text excerpt: it may take two lines. */
  wrapTitle?: boolean;
  icon: LucideIcon;
  open: (actions: SearchActions) => Promise<unknown>;
}

export interface SearchPage {
  items: SearchItem[];
  /** More results exist than were fetched. */
  hasMore: boolean;
  /** Where the next page starts, when the source can continue (the search page's "Load more"). */
  nextCursor?: string;
}

export interface SearchRequest {
  api: ApiClient;
  orgId: string;
  q: string;
  limit: number;
  cursor?: string;
  /** Chips: only sources marked `filterable` are asked when any is set. */
  filters: SearchFilters;
  selfUserId: string;
  signal: AbortSignal;
}

export interface SearchSource {
  id: string;
  /** Section heading. */
  label: string;
  /** Used in "No <noun> match ..." and error messages. */
  noun: string;
  /** Understands the chip filters (messages and files). */
  filterable?: boolean;
  /** Results shown in the palette, when fewer than its default. */
  paletteLimit?: number;
  search: (request: SearchRequest) => Promise<SearchPage>;
}

/** Shape of `GET /orgs/{o}/channels`. */
interface ChannelHit {
  id: string;
  workspaceId: string;
  workspaceName: string;
  name: string;
  type: 'public' | 'private';
  isMember: boolean;
  archivedAt: string | null;
}

const peopleSource: SearchSource = {
  id: 'people',
  label: 'People',
  noun: 'people',
  async search({ api, orgId, q, limit, cursor, selfUserId, signal }) {
    const page = await api.get<Page<Member>>(`/orgs/${orgId}/members`, { q, limit, cursor }, signal);
    return {
      hasMore: Boolean(page.nextCursor),
      nextCursor: page.nextCursor ?? undefined,
      items: page.data
        .filter((member) => member.userId !== selfUserId)
        .map((member) => ({
          key: `person:${member.userId}`,
          title: member.displayName,
          subtitle: member.email,
          matchSubtitle: true,
          icon: UserRound,
          open: async ({ navigate, orgSlug, startDirect }) => {
            const conversation = await startDirect(member.userId);
            await navigate({
              to: '/o/$orgSlugOrId/messages/$conversationId',
              params: { orgSlugOrId: orgSlug, conversationId: conversation.id },
            });
          },
        })),
    };
  },
};

const channelsSource: SearchSource = {
  id: 'channels',
  label: 'Channels',
  noun: 'channels',
  async search({ api, orgId, q, limit, cursor, signal }) {
    const page = await api.get<Page<ChannelHit>>(`/orgs/${orgId}/channels`, { q, limit, cursor }, signal);
    return {
      hasMore: Boolean(page.nextCursor),
      nextCursor: page.nextCursor ?? undefined,
      items: page.data.map((channel) => ({
        key: `channel:${channel.id}`,
        title: channel.name,
        subtitle: `in ${channel.workspaceName}`,
        badges: [...(channel.type === 'private' ? ['Private'] : []), ...(channel.archivedAt ? ['Archived'] : [])],
        icon: channel.type === 'private' ? Lock : Hash,
        open: ({ navigate, orgSlug }) =>
          navigate({
            to: '/o/$orgSlugOrId/w/$workspaceId/c/$channelId',
            params: { orgSlugOrId: orgSlug, workspaceId: channel.workspaceId, channelId: channel.id },
          }),
      })),
    };
  },
};

const workspacesSource: SearchSource = {
  id: 'workspaces',
  label: 'Workspaces',
  noun: 'workspaces',
  async search({ api, orgId, q, limit, cursor, signal }) {
    const page = await api.get<Page<Workspace>>(`/orgs/${orgId}/workspaces`, { q, limit, cursor }, signal);
    return {
      hasMore: Boolean(page.nextCursor),
      nextCursor: page.nextCursor ?? undefined,
      items: page.data.map((workspace) => ({
        key: `workspace:${workspace.id}`,
        title: workspace.name,
        subtitle: workspace.description ?? undefined,
        badges: [
          ...(workspace.visibility === 'private' ? ['Private'] : []),
          ...(workspace.archivedAt ? ['Archived'] : []),
        ],
        icon: Boxes,
        open: ({ navigate, orgSlug }) =>
          navigate({
            to: '/o/$orgSlugOrId/w/$workspaceId',
            params: { orgSlugOrId: orgSlug, workspaceId: workspace.id },
          }),
      })),
    };
  },
};

/** Where a hit lives (`GET /orgs/{o}/message-search`). */
type HitLocation =
  { kind: 'channel'; workspaceId: string; channelId: string } | { kind: 'direct' | 'group'; conversationId: string };

interface MessageHit {
  id: string;
  senderUserId: string | null;
  body: string | null;
  threadRootId: string | null;
  createdAt: string;
  location: HitLocation;
}

interface FileHit {
  fileId: string;
  name: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  messageId: string;
  location: HitLocation;
  createdAt: string;
}

const filterQuery = (filters: SearchFilters) => ({
  from: filters.from,
  channelId: filters.channelId,
  before: filters.before,
  after: filters.after,
  has: filters.hasFile ? 'file' : undefined,
});

/** Best effort: a lookup that fails only costs the name, never the results. */
async function lookup<T>(task: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await task();
  } catch {
    return fallback;
  }
}

async function senderNames(
  api: ApiClient,
  orgId: string,
  hits: { senderUserId: string | null }[],
  signal: AbortSignal,
) {
  const ids = [...new Set(hits.map((hit) => hit.senderUserId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map<string, string>();
  const page = await lookup(
    () => api.get<Page<Member>>(`/orgs/${orgId}/members`, { userId: ids, limit: Math.min(ids.length, 100) }, signal),
    { data: [] as Member[] },
  );
  return new Map(page.data.map((member) => [member.userId, member.displayName]));
}

async function channelNames(api: ApiClient, orgId: string, hits: { location: HitLocation }[], signal: AbortSignal) {
  const channels = new Map<string, string>();
  const wanted = new Map<string, string>();
  for (const { location } of hits)
    if (location.kind === 'channel') wanted.set(location.channelId, location.workspaceId);
  await Promise.all(
    [...wanted].map(async ([channelId, workspaceId]) => {
      const channel = await lookup(
        () => api.get<{ name: string }>(`/orgs/${orgId}/workspaces/${workspaceId}/channels/${channelId}`, {}, signal),
        null,
      );
      if (channel) channels.set(channelId, channel.name);
    }),
  );
  return channels;
}

const placeOf = (location: HitLocation, channels: Map<string, string>): string => {
  if (location.kind === 'channel')
    return channels.has(location.channelId) ? `#${channels.get(location.channelId)}` : 'a channel';
  return location.kind === 'direct' ? 'a direct message' : 'a group conversation';
};

const openLocation = (location: HitLocation, messageId: string, { navigate, orgSlug }: SearchActions) =>
  location.kind === 'channel'
    ? navigate({
        to: '/o/$orgSlugOrId/w/$workspaceId/c/$channelId',
        params: { orgSlugOrId: orgSlug, workspaceId: location.workspaceId, channelId: location.channelId },
        search: { message: messageId },
      })
    : navigate({
        to: '/o/$orgSlugOrId/messages/$conversationId',
        params: { orgSlugOrId: orgSlug, conversationId: location.conversationId },
        search: { message: messageId },
      });

const messagesSource: SearchSource = {
  id: 'messages',
  label: 'Messages',
  noun: 'messages',
  filterable: true,
  paletteLimit: 3,
  async search({ api, orgId, q, limit, cursor, filters, signal }) {
    const page = await api.get<Page<MessageHit>>(
      `/orgs/${orgId}/message-search`,
      { q, limit, cursor, ...filterQuery(filters) },
      signal,
    );
    const [people, channels] = await Promise.all([
      senderNames(api, orgId, page.data, signal),
      channelNames(api, orgId, page.data, signal),
    ]);
    const terms = queryTerms(q);
    return {
      hasMore: Boolean(page.nextCursor),
      nextCursor: page.nextCursor ?? undefined,
      items: page.data.map((hit) => ({
        key: `message:${hit.id}`,
        title: snippetOf(hit.body ?? '', terms),
        subtitle: [
          hit.senderUserId ? (people.get(hit.senderUserId) ?? 'Former member') : 'System',
          `in ${placeOf(hit.location, channels)}`,
          formatRelative(hit.createdAt),
        ].join(' · '),
        badges: hit.threadRootId ? ['Reply'] : [],
        matchWords: true,
        wrapTitle: true,
        icon: MessageSquare,
        open: (actions) => openLocation(hit.location, hit.id, actions),
      })),
    };
  },
};

const filesSource: SearchSource = {
  id: 'files',
  label: 'Files',
  noun: 'files',
  filterable: true,
  paletteLimit: 3,
  async search({ api, orgId, q, limit, cursor, filters, signal }) {
    const attached = await api.get<Page<FileHit>>(
      `/orgs/${orgId}/message-search`,
      { q, limit, cursor, type: 'files', ...filterQuery(filters) },
      signal,
    );
    // The caller's own uploads (files service) join the first page; they are not tied to a conversation, so they
    // cannot match a chip. Filtered here as well, so the answer is right whatever the service does with `q`.
    const own =
      cursor === undefined && !hasFilters(filters)
        ? (await api.get<Page<StoredFile>>(`/orgs/${orgId}/files`, { q, limit }, signal)).data
            .filter((file) => file.status === 'available' && file.name.toLowerCase().includes(q.toLowerCase()))
            .slice(0, limit)
        : [];
    const channels = await channelNames(api, orgId, attached.data, signal);
    const seen = new Set<string>();
    const items: SearchItem[] = [];
    for (const hit of attached.data) {
      if (seen.has(hit.fileId)) continue;
      seen.add(hit.fileId);
      const file: OpenableFile = {
        id: hit.fileId,
        name: hit.name ?? 'File',
        mimeType: hit.mimeType ?? 'application/octet-stream',
        sizeBytes: hit.sizeBytes ?? 0,
      };
      items.push({
        key: `file:${hit.fileId}:${hit.messageId}`,
        title: file.name,
        subtitle: `${typeLabel(file.mimeType)} · ${formatBytes(file.sizeBytes)} · in ${placeOf(hit.location, channels)} · ${formatRelative(hit.createdAt)}`,
        matchSubtitle: false,
        icon: FileIcon,
        open: (actions) => actions.openFile(file),
      });
    }
    for (const file of own) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      items.push({
        key: `file:${file.id}`,
        title: file.name,
        subtitle: `${typeLabel(file.mimeType)} · ${formatBytes(file.sizeBytes)} · your upload · ${formatRelative(file.createdAt)}`,
        icon: FileIcon,
        open: (actions) => actions.openFile(file),
      });
    }
    return { items, hasMore: Boolean(attached.nextCursor), nextCursor: attached.nextCursor ?? undefined };
  },
};

/** In display order. */
export const searchSources: readonly SearchSource[] = [
  peopleSource,
  channelsSource,
  workspacesSource,
  messagesSource,
  filesSource,
];
