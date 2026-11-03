import { cn } from '@smartconnect/ui/lib/utils';
import { motion } from 'motion/react';
import type { ReactNode, Ref } from 'react';
import { enterTransition } from '@/lib/motion';

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

interface MessageRowProps {
  /** The message id: the row becomes the target of its permalink. */
  messageId?: string;
  senderName: string;
  createdAt: string;
  edited?: boolean;
  /** Not yet confirmed by the server: shown dimmed, and settles to full opacity once confirmed. */
  pending?: boolean;
  /** Arrived after the conversation was first shown: fades and rises in. */
  isNew?: boolean;
  /** Draws the "New messages" divider above this message; the ref lets the log scroll to it. */
  divider?: Ref<HTMLDivElement>;
  /** Hover and focus controls (react, more actions). */
  actions?: ReactNode;
  /** The message a jump landed on. */
  highlight?: boolean;
  children: ReactNode;
}

/** Chrome of one message. A pending message and its confirmed version share a React key, so it settles in place. */
export function MessageRow({
  messageId,
  senderName,
  createdAt,
  edited,
  pending,
  isNew,
  divider,
  actions,
  highlight,
  children,
}: MessageRowProps) {
  return (
    <motion.li
      id={messageId ? `message-${messageId}` : undefined}
      tabIndex={messageId ? -1 : undefined}
      initial={isNew ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: pending ? 0.6 : 1, y: 0 }}
      transition={enterTransition}
      data-highlight={highlight ? 'true' : undefined}
      className={cn(
        'group relative flex flex-col gap-0.5 rounded-md px-2 py-1.5 outline-none target:bg-accent hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring',
        highlight && 'bg-accent ring-2 ring-primary/50',
      )}
    >
      {divider ? <NewMessagesDivider ref={divider} /> : null}
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-medium">{senderName}</span>
        <time dateTime={createdAt} className="text-xs text-muted-foreground">
          {timeFormat.format(new Date(createdAt))}
        </time>
        {edited ? <span className="text-xs text-muted-foreground">(edited)</span> : null}
      </div>
      {children}
      {actions ? (
        <div className="absolute -top-3 right-2 flex rounded-md border border-border bg-popover opacity-0 shadow-sm transition-opacity duration-(--sc-duration-fast) group-focus-within:opacity-100 group-hover:opacity-100 has-data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100">
          {actions}
        </div>
      ) : null}
    </motion.li>
  );
}

function NewMessagesDivider({ ref }: { ref: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      role="separator"
      aria-label="New messages"
      className="mb-1 flex items-center gap-2 text-xs text-danger"
    >
      <span className="h-px flex-1 bg-danger/40" aria-hidden="true" />
      <span className="font-medium">New messages</span>
      <span className="h-px flex-1 bg-danger/40" aria-hidden="true" />
    </div>
  );
}
