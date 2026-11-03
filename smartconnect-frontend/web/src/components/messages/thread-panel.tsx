import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useRef } from 'react';
import { describeError } from '@/lib/api/messages';
import { enterTransition } from '@/lib/motion';
import { useAttachmentDraft } from '@/lib/use-attachment-draft';
import type { Mentionable } from '@/lib/message-format';
import { useReplies, useSendReply, type MessageScope } from '@/lib/queries/message-actions';
import { Composer } from './composer';
import { MessageItem, type ItemActions, type ThreadMessage } from './message-item';

export const THREAD_PANEL_ID = 'thread-panel';

interface ThreadPanelProps {
  scope: MessageScope;
  orgId: string;
  root: ThreadMessage;
  nameOf: (userId: string | null) => string;
  selfId: string;
  mentionables: readonly Mentionable[];
  actions: ItemActions;
  /** May post here (a reply is a post). */
  canPost: boolean;
  canModerate: boolean;
  onClose: () => void;
}

/** A thread beside the timeline: the root, its replies oldest first, and a reply box. Escape closes it. */
export function ThreadPanel({
  scope,
  orgId,
  root,
  nameOf,
  selfId,
  mentionables,
  actions,
  canPost,
  canModerate,
  onClose,
}: ThreadPanelProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const replies = useReplies(scope, root.id);
  const send = useSendReply(scope, root.id);
  const draft = useAttachmentDraft(orgId);
  const list = useMemo(() => replies.data?.pages.flatMap((page) => page.data) ?? [], [replies.data]);
  const rootDeleted = root.deletedAt !== null;

  // Move focus into the panel when it opens; whoever closes it takes it back.
  useEffect(() => heading.current?.focus(), []);

  const itemFor = (message: ThreadMessage, isRoot: boolean) => (
    <MessageItem
      key={message.id}
      message={message}
      nameOf={nameOf}
      selfId={selfId}
      mentionables={mentionables}
      actions={actions}
      anchor={false}
      orgId={orgId}
      canEdit={message.senderUserId === selfId && message.type === 'standard'}
      canDelete={isRoot ? false : (message.senderUserId === selfId || canModerate) && message.type === 'standard'}
    />
  );

  return (
    <motion.aside
      id={THREAD_PANEL_ID}
      aria-labelledby="thread-panel-heading"
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      transition={enterTransition}
      onKeyDown={(event) => {
        // Menus and dialogs opened from here are portaled but still bubble their events through the panel.
        if (event.key === 'Escape' && !event.defaultPrevented && event.currentTarget.contains(event.target as Node)) {
          onClose();
        }
      }}
      className="absolute inset-y-0 right-0 z-10 flex w-96 max-w-full flex-col gap-3 border-l border-border bg-background p-3 shadow-lg"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="thread-panel-heading" ref={heading} tabIndex={-1} className="text-md font-semibold outline-none">
          Thread
        </h3>
        <Button size="icon" variant="ghost" aria-label="Close thread" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        <ul aria-label="Thread root" className="flex flex-col border-b border-border pb-2">
          {itemFor(root, true)}
        </ul>
        {replies.isPending ? <p className="text-sm text-muted-foreground">Loading replies…</p> : null}
        {replies.isError ? (
          <Alert tone="danger" role="alert">
            {describeError(replies.error)}{' '}
            <button type="button" className="underline" onClick={() => void replies.refetch()}>
              Try again
            </button>
          </Alert>
        ) : null}
        {replies.isSuccess && list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No replies yet.</p>
        ) : null}
        <ul aria-label="Replies" className="flex flex-col">
          {list.map((reply) => itemFor(reply, false))}
        </ul>
        {replies.hasNextPage ? (
          <Button
            variant="outline"
            size="sm"
            className="self-center"
            disabled={replies.isFetchingNextPage}
            onClick={() => void replies.fetchNextPage()}
          >
            {replies.isFetchingNextPage ? 'Loading…' : 'Load more replies'}
          </Button>
        ) : null}
      </div>

      {canPost && !rootDeleted ? (
        <Composer
          label="Reply in thread"
          mentionables={mentionables}
          draft={draft}
          onSend={(body, attachments) =>
            send.mutateAsync({
              body,
              clientMessageId: crypto.randomUUID(),
              attachmentFileIds: attachments.map((a) => a.fileId),
            })
          }
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          {rootDeleted ? 'The original message was deleted, so there is no replying.' : "You can't reply here."}
        </p>
      )}
    </motion.aside>
  );
}
