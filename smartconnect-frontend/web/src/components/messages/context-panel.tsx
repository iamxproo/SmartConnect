import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { ArrowDownToLine, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { describeError } from '@/lib/api/messages';
import type { Message } from '@/lib/api/types';
import { enterTransition } from '@/lib/motion';
import type { Mentionable } from '@/lib/message-format';
import { useMessageContext, type MessageScope } from '@/lib/queries/message-actions';
import { MessageItem, type ItemActions, type ThreadMessage } from './message-item';

export const CONTEXT_PANEL_ID = 'message-context-panel';

interface ContextPanelProps {
  scope: MessageScope;
  orgId: string;
  messageId: string;
  nameOf: (userId: string | null) => string;
  selfId: string;
  mentionables: readonly Mentionable[];
  actions: ItemActions;
  canModerate: boolean;
  onOpenThread: (root: ThreadMessage) => void;
  onJumpToLatest: () => void;
  onClose: () => void;
}

/** The messages around one message (a jump from search, activity or a link), the target highlighted. */
export function ContextPanel({
  scope,
  orgId,
  messageId,
  nameOf,
  selfId,
  mentionables,
  actions,
  canModerate,
  onOpenThread,
  onJumpToLatest,
  onClose,
}: ContextPanelProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const target = useRef<HTMLUListElement>(null);
  const context = useMessageContext(scope, messageId);
  const data = context.data;

  useEffect(() => heading.current?.focus(), []);
  // Bring the target into view once, when the context first arrives.
  const arrived = data !== undefined;
  useEffect(() => {
    if (arrived) target.current?.querySelector('[data-highlight]')?.scrollIntoView?.({ block: 'center' });
  }, [arrived, messageId]);

  return (
    <motion.aside
      id={CONTEXT_PANEL_ID}
      aria-labelledby="message-context-heading"
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      transition={enterTransition}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented && event.currentTarget.contains(event.target as Node)) {
          onClose();
        }
      }}
      className="absolute inset-y-0 right-0 z-10 flex w-96 max-w-full flex-col gap-3 border-l border-border bg-background p-3 shadow-lg"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="message-context-heading" ref={heading} tabIndex={-1} className="text-md font-semibold outline-none">
          Message in context
        </h3>
        <Button size="icon" variant="ghost" aria-label="Close message context" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <Button variant="outline" size="sm" className="w-fit" onClick={onJumpToLatest}>
        <ArrowDownToLine aria-hidden="true" />
        Jump to latest
      </Button>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {context.isPending ? <p className="text-sm text-muted-foreground">Loading messages…</p> : null}
        {context.isError ? (
          <Alert tone="danger" role="alert">
            {describeError(context.error, {})}{' '}
            <button type="button" className="underline" onClick={() => void context.refetch()}>
              Try again
            </button>
          </Alert>
        ) : null}
        {data?.isReply ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            This message is a reply in a thread.
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const root = data.data.find((m) => m.id === data.targetId);
                if (root) onOpenThread(root);
              }}
            >
              Open thread
            </Button>
          </p>
        ) : null}
        {data ? (
          <ul ref={target} aria-label="Messages around the message" className="flex flex-col">
            {data.data.map((message: Message) => (
              <MessageItem
                key={message.id}
                message={message}
                nameOf={nameOf}
                selfId={selfId}
                mentionables={mentionables}
                actions={actions}
                anchor={false}
                orgId={orgId}
                highlight={message.id === data.targetId}
                canEdit={message.senderUserId === selfId && message.type === 'standard'}
                canDelete={(message.senderUserId === selfId || canModerate) && message.type === 'standard'}
                onOpenThread={onOpenThread}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </motion.aside>
  );
}
