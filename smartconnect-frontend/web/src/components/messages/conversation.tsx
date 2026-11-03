import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { cn } from '@smartconnect/ui/lib/utils';
import { useQueryClient, type InfiniteData, type UseInfiniteQueryResult } from '@tanstack/react-query';
import { AnimatePresence } from 'motion/react';
import { Paperclip } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog';
import { useToast } from '@/components/toast/toaster';
import { ApiError } from '@/lib/api/errors';
import { describeError } from '@/lib/api/messages';
import type { Channel, MessagePage } from '@/lib/api/types';
import { useUser } from '@/lib/auth';
import { useAttachmentDraft, type DraftAttachment } from '@/lib/use-attachment-draft';
import type { Mentionable } from '@/lib/message-format';
import { usePageVisible } from '@/lib/page-visible';
import { channelScope, useBookmark, useReact, type MessageScope } from '@/lib/queries/message-actions';
import {
  useDeleteMessage,
  useEditMessage,
  useMarkChannelRead,
  useMessages,
  useSendMessage,
} from '@/lib/queries/messages';
import { useMembers } from '@/lib/queries/orgs';
import { useJoinChannel } from '@/lib/queries/workspaces';
import { Composer } from './composer';
import { ContextPanel } from './context-panel';
import { MessageItem, type ItemActions, type ThreadMessage } from './message-item';
import { MessageRow } from './message-row';
import { MessageText } from './message-body';
import { ThreadPanel } from './thread-panel';

export type { ThreadMessage } from './message-item';

interface OutboxItem {
  clientMessageId: string;
  body: string;
  attachments: DraftAttachment[];
  createdAt: string;
  status: 'sending' | 'failed';
  error?: string;
}

const NEAR_BOTTOM_PX = 80;
const NEAR_TOP_PX = 40;

/** History, composer and the states around posting for one channel. No typing or presence: not implemented. */
export function Conversation({
  orgId,
  workspaceId,
  channel,
  focusMessageId,
  onFocusClear,
}: {
  orgId: string;
  workspaceId: string;
  channel: Channel;
  /** The `?message=` parameter: open the context around this message. */
  focusMessageId?: string;
  onFocusClear?: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const user = useUser();
  const messages = useMessages(orgId, workspaceId, channel.id);
  const directory = useMembers(orgId);
  const send = useSendMessage(orgId, workspaceId, channel.id);
  const edit = useEditMessage(orgId, workspaceId, channel.id);
  const remove = useDeleteMessage(orgId, workspaceId, channel.id);
  const join = useJoinChannel(orgId, workspaceId);
  const scope = useMemo(() => channelScope(orgId, workspaceId, channel.id), [orgId, workspaceId, channel.id]);

  const names = useMemo(
    () => new Map(directory.data?.map((member) => [member.userId, member.displayName])),
    [directory.data],
  );
  // Any active member of the organization can be mentioned in a channel.
  const mentionables = useMemo<Mentionable[]>(
    () => directory.data?.map((member) => ({ userId: member.userId, name: member.displayName })) ?? [],
    [directory.data],
  );

  // Mark as read: the newest message from someone else, once per message, while the tab is visible.
  const visible = usePageVisible();
  const markRead = useMarkChannelRead(orgId, workspaceId, channel.id).mutate;
  const marked = useRef<string | null>(null);
  const newest = messages.data?.pages[0]?.data[0];
  const fetchedNow = messages.isFetchedAfterMount;
  useEffect(() => {
    // Your own messages already moved your cursor on the server; wait for fresh data so a stale cache never marks.
    if (!visible || !fetchedNow || !newest || newest.senderUserId === user.id || marked.current === newest.id) return;
    marked.current = newest.id;
    markRead(newest.id);
  }, [visible, fetchedNow, newest, user.id, markRead]);

  return (
    <MessageThread
      label={`Messages in #${channel.name}`}
      messages={messages}
      scope={scope}
      orgId={orgId}
      permalink={(id) => `${window.location.origin}${window.location.pathname}#message-${id}`}
      mentionables={mentionables}
      nameOf={(userId) => (userId && names.get(userId)) || 'Former member'}
      canModerate={channel.myRole === 'admin'}
      focusMessageId={focusMessageId}
      onFocusClear={onFocusClear}
      onSend={(body, clientMessageId, attachmentFileIds) =>
        send.mutateAsync({ body, clientMessageId, attachmentFileIds })
      }
      onSendFailed={(error) => {
        // Membership or archive state changed under us: refresh what the composer depends on.
        if (error instanceof ApiError && ['not_a_channel_member', 'channel_archived'].includes(error.code)) {
          void queryClient.invalidateQueries({ queryKey: ['orgs', orgId, 'workspaces', workspaceId, 'channels'] });
        }
      }}
      onEdit={(id, body) => edit.mutateAsync({ id, body })}
      onDelete={(id) => remove.mutateAsync(id)}
      compose={channel.isMember && !channel.archivedAt ? { label: `Message #${channel.name}` } : null}
      notice={
        channel.archivedAt ? (
          <Alert>This channel is archived. You can read it, but nobody can post.</Alert>
        ) : !channel.isMember ? (
          <Alert className="flex flex-wrap items-center justify-between gap-2">
            <span>You can read this channel but not post in it.</span>
            <Button
              size="sm"
              disabled={join.isPending}
              onClick={() =>
                join.mutate(channel.id, {
                  onSuccess: () => toast({ title: `Joined #${channel.name}` }),
                  onError: (error) =>
                    toast({ title: "Couldn't join", description: describeError(error), tone: 'error' }),
                })
              }
            >
              Join channel to post
            </Button>
          </Alert>
        ) : null
      }
      footer={<p className="text-xs text-muted-foreground">New messages appear within a few seconds.</p>}
    />
  );
}

interface MessageThreadProps<T extends ThreadMessage> {
  /** Accessible name of the message log. */
  label: string;
  /** Newest-first pages. The first page may carry the caller's unread count. */
  messages: UseInfiniteQueryResult<InfiniteData<MessagePage<T>>>;
  /** Where these messages live: replies, reactions and saving go through it. */
  scope: MessageScope;
  orgId: string;
  /** A link that opens the app at the message. */
  permalink: (messageId: string) => string;
  /** People who can be mentioned here. */
  mentionables: readonly Mentionable[];
  nameOf: (userId: string | null) => string;
  /** May delete other people's messages. */
  canModerate: boolean;
  /** Repeating a clientMessageId must be safe: retries reuse it. */
  onSend: (body: string, clientMessageId: string, attachmentFileIds: string[]) => Promise<unknown>;
  /** The `?message=` parameter: show the messages around this one in a panel. */
  focusMessageId?: string;
  /** Leave the focused message (close the panel, or jump to the latest messages). */
  onFocusClear?: () => void;
  onSendFailed?: (error: unknown) => void;
  onEdit: (id: string, body: string) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
  /** The composer under the log; null when posting is not possible. */
  compose: { label: string; disabled?: boolean } | null;
  /** Why posting is not (or no longer) possible. */
  notice?: ReactNode;
  footer?: ReactNode;
  /** Fill the height of the parent instead of a fixed share of the viewport. */
  fill?: boolean;
}

/** The oldest message of the caller's unread run: the n-th newest from someone else (or the oldest loaded). */
export function firstUnread(list: readonly ThreadMessage[], selfId: string, unread: number): string | null {
  if (unread <= 0) return null;
  let seen = 0;
  let oldest: string | null = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i]!;
    if (message.senderUserId === selfId || message.deletedAt !== null) continue;
    oldest = message.id;
    if (++seen === unread) break;
  }
  return oldest;
}

/**
 * Scrolling history with paging, the outbox (optimistic sends with retry), edit and delete, a "New messages" divider,
 * and the thread panel, reactions and saving, for any message source.
 */
export function MessageThread<T extends ThreadMessage>({
  label,
  messages,
  scope,
  orgId,
  permalink,
  mentionables,
  nameOf,
  canModerate,
  onSend,
  focusMessageId,
  onFocusClear,
  onSendFailed,
  onEdit,
  onDelete,
  compose,
  notice,
  footer,
  fill,
}: MessageThreadProps<T>) {
  const user = useUser();
  const toast = useToast();
  const [outbox, setOutbox] = useState<OutboxItem[]>([]);
  const [deleting, setDeleting] = useState<ThreadMessage | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  // A root opened from the context panel may not be in the loaded timeline.
  const [threadFallback, setThreadFallback] = useState<ThreadMessage | null>(null);
  const draft = useAttachmentDraft(orgId);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const react = useReact(scope).mutate;
  const bookmark = useBookmark(scope, orgId).mutate;

  // Pages are newest first; show oldest to newest, once per id.
  const confirmed = useMemo(() => {
    const seen = new Set<string>();
    const list: T[] = [];
    for (const page of messages.data?.pages ?? []) {
      for (const message of page.data) {
        if (!seen.has(message.id)) {
          seen.add(message.id);
          list.push(message);
        }
      }
    }
    return list.reverse();
  }, [messages.data]);
  const pending = outbox.filter(
    (item) => !confirmed.some((message) => message.clientMessageId === item.clientMessageId),
  );
  const thread = threadId
    ? (confirmed.find((message) => message.id === threadId) ??
      (threadFallback?.id === threadId ? threadFallback : null))
    : null;

  // ---- scrolling: stay at the bottom for new messages, keep position when older ones are prepended ----
  const log = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const restore = useRef<{ height: number; top: number } | null>(null);
  // Newest message at first display: anything newer arrived later and animates in.
  const [baseline, setBaseline] = useState<string | null>(null);
  if (baseline === null && messages.isSuccess) setBaseline(confirmed.at(-1)?.createdAt ?? '');
  // Where the unread run began when the conversation was opened (undefined: not known yet). It stays put while open.
  const [dividerId, setDividerId] = useState<string | null | undefined>(undefined);
  if (dividerId === undefined && messages.isSuccess && messages.isFetchedAfterMount) {
    setDividerId(firstUnread(confirmed, user.id, messages.data.pages[0]?.unreadCount ?? 0));
  }
  const dividerElement = useRef<HTMLDivElement>(null);
  const dividerShown = useRef(false);

  useLayoutEffect(() => {
    const element = log.current;
    if (!element) return;
    if (restore.current) {
      element.scrollTop = restore.current.top + (element.scrollHeight - restore.current.height);
      restore.current = null;
    } else if (dividerElement.current && !dividerShown.current) {
      dividerShown.current = true;
      dividerElement.current.scrollIntoView?.({ block: 'start' });
    } else if (stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [confirmed.length, pending.length, dividerId]);

  // A permalink (#message-<id>) brings its message into view once it is loaded.
  const target = useRef(window.location.hash);
  useEffect(() => {
    if (!target.current.startsWith('#message-') || !messages.isSuccess) return;
    const element = document.getElementById(target.current.slice(1));
    if (!element) return;
    target.current = '';
    element.scrollIntoView?.({ block: 'center' });
  }, [messages.isSuccess, confirmed.length]);

  function loadOlder() {
    const element = log.current;
    if (!element || !messages.hasNextPage || messages.isFetchingNextPage) return;
    restore.current = { height: element.scrollHeight, top: element.scrollTop };
    void messages.fetchNextPage();
  }

  function onScroll() {
    const element = log.current;
    if (!element) return;
    stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    if (element.scrollTop < NEAR_TOP_PX) loadOlder();
  }

  // ---- sending: the same clientMessageId is reused on retry, so a retry can never duplicate ----
  function update(clientMessageId: string, patch: Partial<OutboxItem>) {
    setOutbox((items) =>
      items.map((item) => (item.clientMessageId === clientMessageId ? { ...item, ...patch } : item)),
    );
  }

  async function deliver(item: OutboxItem) {
    update(item.clientMessageId, { status: 'sending', error: undefined });
    try {
      await onSend(
        item.body,
        item.clientMessageId,
        item.attachments.map((a) => a.fileId),
      );
      setOutbox((items) => items.filter((other) => other.clientMessageId !== item.clientMessageId));
    } catch (error) {
      update(item.clientMessageId, { status: 'failed', error: describeError(error) });
      onSendFailed?.(error);
    }
  }

  function submit(body: string, attachments: DraftAttachment[]) {
    stickToBottom.current = true;
    const item: OutboxItem = {
      clientMessageId: crypto.randomUUID(),
      body,
      attachments,
      createdAt: new Date().toISOString(),
      status: 'sending',
    };
    setOutbox((items) => [...items, item]);
    void deliver(item);
  }

  // ---- what a message offers ----
  const canReact = compose !== null;
  const failed = (title: string) => ({
    onError: (error: unknown) => toast({ title, description: describeError(error), tone: 'error' as const }),
  });
  const actions: ItemActions = {
    canReact,
    react: (id, emoji, on) => react({ id, emoji, on }, failed("Couldn't update the reaction")),
    save: (id, saved) => bookmark({ id, saved }, failed(saved ? "Couldn't save the message" : "Couldn't remove it")),
    copyLink: (id) => {
      navigator.clipboard.writeText(permalink(id)).then(
        () => toast({ title: 'Link copied' }),
        () => toast({ title: "Couldn't copy the link", tone: 'error' }),
      );
    },
    edit: onEdit,
    remove: (message) => setDeleting(message),
  };
  const mayDelete = (message: ThreadMessage) =>
    (message.senderUserId === user.id || canModerate) && message.type === 'standard';

  function jumpToLatest() {
    onFocusClear?.();
    stickToBottom.current = true;
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }

  // ---- files dropped anywhere on the conversation are attached to the message being written ----
  const canAttach = compose !== null && !compose.disabled;
  const carriesFiles = (event: DragEvent) => canAttach && event.dataTransfer.types.includes('Files');
  function dragEnter(event: DragEvent) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }
  function dragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }
  function drop(event: DragEvent) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    draft.add([...event.dataTransfer.files]);
  }

  function closeThread() {
    const id = threadId;
    setThreadId(null);
    // Back to the message the thread was opened from.
    if (id) window.setTimeout(() => document.getElementById(`message-${id}`)?.focus(), 0);
  }

  return (
    <section
      aria-label="Conversation"
      onDragEnter={dragEnter}
      onDragOver={(event) => carriesFiles(event) && event.preventDefault()}
      onDragLeave={dragLeave}
      onDrop={drop}
      className={cn('relative flex flex-col gap-3', fill && 'min-h-0 flex-1')}
    >
      {dragging ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center gap-2 rounded-lg border-2 border-dashed border-primary bg-surface-selected/80 text-sm font-medium"
        >
          <Paperclip className="size-4" />
          Drop files to attach
        </div>
      ) : null}
      <div
        ref={log}
        role="log"
        aria-live="polite"
        aria-label={label}
        tabIndex={0}
        onScroll={onScroll}
        className={cn(
          'overflow-y-auto rounded-lg border border-border bg-card p-2',
          fill ? 'min-h-0 flex-1' : 'h-[50dvh]',
        )}
      >
        {messages.hasNextPage ? (
          <div className="flex justify-center py-2">
            <Button variant="outline" size="sm" disabled={messages.isFetchingNextPage} onClick={loadOlder}>
              {messages.isFetchingNextPage ? 'Loading…' : 'Load older messages'}
            </Button>
          </div>
        ) : null}
        {messages.isPending ? <p className="p-2 text-sm text-muted-foreground">Loading messages…</p> : null}
        {messages.isError ? (
          <Alert tone="danger" role="alert" className="m-2">
            {describeError(messages.error)}{' '}
            <button type="button" className="underline" onClick={() => void messages.refetch()}>
              Try again
            </button>
          </Alert>
        ) : null}
        {messages.isSuccess && confirmed.length === 0 && pending.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">No messages yet.</p>
        ) : null}
        <ul className="flex flex-col">
          {confirmed.map((message) => (
            <MessageItem
              key={message.clientMessageId ?? message.id}
              message={message}
              nameOf={nameOf}
              selfId={user.id}
              mentionables={mentionables}
              actions={actions}
              orgId={orgId}
              canEdit={message.senderUserId === user.id && message.type === 'standard'}
              canDelete={mayDelete(message)}
              onOpenThread={(root) => setThreadId(root.id)}
              isNew={baseline !== null && message.createdAt > baseline}
              divider={message.id === dividerId ? dividerElement : undefined}
            />
          ))}
          {pending.map((item) => (
            <MessageRow
              key={item.clientMessageId}
              senderName={nameOf(user.id)}
              createdAt={item.createdAt}
              pending
              isNew
            >
              {item.body ? (
                <MessageText selfId={user.id} nameOf={(userId) => nameOf(userId)}>
                  {item.body}
                </MessageText>
              ) : null}
              {item.attachments.length > 0 ? (
                <ul aria-label="Attachments" className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                  {item.attachments.map((file) => (
                    <li key={file.key} className="flex items-center gap-1">
                      <Paperclip className="size-3.5" aria-hidden="true" />
                      {file.name}
                    </li>
                  ))}
                </ul>
              ) : null}
              {item.status === 'sending' ? (
                <p className="text-xs text-muted-foreground">Sending…</p>
              ) : (
                <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
                  Not sent: {item.error}
                  <Button size="sm" variant="outline" onClick={() => void deliver(item)}>
                    Retry
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOutbox((items) => items.filter((other) => other !== item))}
                  >
                    Discard
                  </Button>
                </p>
              )}
            </MessageRow>
          ))}
        </ul>
      </div>

      {notice}
      {compose ? (
        <Composer
          label={compose.label}
          disabled={compose.disabled}
          mentionables={mentionables}
          draft={draft}
          onSend={submit}
        />
      ) : null}
      {footer}

      <AnimatePresence>
        {focusMessageId && !thread ? (
          <ContextPanel
            key={focusMessageId}
            scope={scope}
            orgId={orgId}
            messageId={focusMessageId}
            nameOf={nameOf}
            selfId={user.id}
            mentionables={mentionables}
            actions={actions}
            canModerate={canModerate}
            onOpenThread={(root) => {
              setThreadFallback(root);
              setThreadId(root.id);
            }}
            onJumpToLatest={jumpToLatest}
            onClose={() => onFocusClear?.()}
          />
        ) : null}
        {thread ? (
          <ThreadPanel
            key={thread.id}
            scope={scope}
            orgId={orgId}
            root={thread}
            nameOf={nameOf}
            selfId={user.id}
            mentionables={mentionables}
            actions={actions}
            canPost={canReact && !compose?.disabled}
            canModerate={canModerate}
            onClose={closeThread}
          />
        ) : null}
      </AnimatePresence>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete this message?"
        description="The message text is erased for everyone. This cannot be undone."
        confirmLabel="Delete message"
        messages={{ message_deleted: 'This message was already deleted.' }}
        onConfirm={async () => {
          if (!deleting) return;
          await onDelete(deleting.id);
          toast({ title: 'Message deleted' });
        }}
      />
    </section>
  );
}
