import { Alert } from '@smartconnect/ui/components/alert';
import { Avatar, AvatarFallback } from '@smartconnect/ui/components/avatar';
import { Badge } from '@smartconnect/ui/components/badge';
import { Button } from '@smartconnect/ui/components/button';
import { cn } from '@smartconnect/ui/lib/utils';
import { Link } from '@tanstack/react-router';
import { BellOff, MessageSquarePlus, Users, UsersRound } from 'lucide-react';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { initials } from '@/components/people-list';
import { levelAt, useNotificationPreferences } from '@/lib/queries/activity';
import { LoadingState } from '@/components/states/loading-state';
import { describeError } from '@/lib/api/messages';
import type { Conversation } from '@/lib/api/types';
import { useUser } from '@/lib/auth';
import { enterTransition } from '@/lib/motion';
import { conversationName, useConversations, useMemberNames } from '@/lib/queries/conversations';
import { useRequiredOrg } from '@/lib/queries/orgs';
import { formatRelative } from '@/lib/relative-time';
import { NewDirectDialog, NewGroupDialog } from './new-conversation';

/** The server caps the count at 100, which means "100 or more". */
export const UNREAD_CAP = 100;
export const unreadLabel = (count: number) => (count >= UNREAD_CAP ? '99+' : String(count));

/** Conversations in the order the server returns them (latest activity first). */
export function ConversationList({ activeId }: { activeId?: string }) {
  const org = useRequiredOrg();
  const user = useUser();
  const query = useConversations(org.id);
  const [dialog, setDialog] = useState<'direct' | 'group' | null>(null);

  const conversations = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages ?? []).flatMap((page) => page.data).filter((c) => !seen.has(c.id) && seen.add(c.id));
  }, [query.data]);
  const participantIds = useMemo(
    () => conversations.flatMap((c) => c.participants.map((p) => p.userId)),
    [conversations],
  );
  const nameOf = useMemberNames(org.id, participantIds);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
        <h2 className="text-md font-semibold">Conversations</h2>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => setDialog('direct')}>
            <MessageSquarePlus aria-hidden="true" />
            New message
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog('group')}>
            <UsersRound aria-hidden="true" />
            New group
          </Button>
        </div>
      </div>
      <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending ? <LoadingState label="Loading conversations" /> : null}
        {query.isError ? (
          <Alert tone="danger" role="alert" className="m-3">
            {describeError(query.error)}{' '}
            <button type="button" className="underline" onClick={() => void query.refetch()}>
              Try again
            </button>
          </Alert>
        ) : null}
        {query.isSuccess && conversations.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No conversations yet. Start one with “New message” or “New group”.
          </p>
        ) : null}
        <ul className="flex flex-col">
          {conversations.map((conversation) => (
            <ConversationItem
              key={conversation.id}
              conversation={conversation}
              name={conversationName(conversation, user.id, nameOf)}
              active={conversation.id === activeId}
            />
          ))}
        </ul>
        {query.hasNextPage ? (
          <div className="flex justify-center p-3">
            <Button
              size="sm"
              variant="outline"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more conversations'}
            </Button>
          </div>
        ) : null}
      </nav>
      <NewDirectDialog open={dialog === 'direct'} onOpenChange={(open) => setDialog(open ? 'direct' : null)} />
      <NewGroupDialog open={dialog === 'group'} onOpenChange={(open) => setDialog(open ? 'group' : null)} />
    </div>
  );
}

function ConversationItem({
  conversation,
  name,
  active,
}: {
  conversation: Conversation;
  name: string;
  active: boolean;
}) {
  const org = useRequiredOrg();
  const unread = conversation.unreadCount;
  const level = levelAt(useNotificationPreferences(org.id).data, {
    kind: conversation.kind,
    conversationId: conversation.id,
  });
  return (
    // `layout` animates the row to its new place when activity reorders the list.
    <motion.li layout="position" transition={enterTransition}>
      <Link
        to="/o/$orgSlugOrId/messages/$conversationId"
        params={{ orgSlugOrId: org.slug, conversationId: conversation.id }}
        className={cn(
          'flex items-center gap-3 px-3 py-2.5 text-sm transition-colors duration-(--sc-duration-fast) ease-standard',
          'hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
          active && 'bg-surface-selected',
        )}
      >
        <Avatar className="size-8">
          <AvatarFallback>
            {conversation.kind === 'group' ? <Users className="size-4" aria-hidden="true" /> : initials(name) || '?'}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate', unread > 0 ? 'font-semibold' : 'font-medium')}>
            {name}
            {conversation.kind === 'group' ? <span className="sr-only">, group</span> : null}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <time dateTime={conversation.lastActivityAt} className="text-xs text-muted-foreground">
            {formatRelative(conversation.lastActivityAt)}
          </time>
          {level !== 'all' ? (
            <>
              <BellOff className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="sr-only">{level === 'none' ? 'Notifications off' : 'Mentions only'}</span>
            </>
          ) : null}
          {unread > 0 ? (
            <>
              <Badge aria-hidden="true" className="border-transparent bg-primary text-primary-foreground">
                {unreadLabel(unread)}
              </Badge>
              <span className="sr-only">
                {unread >= UNREAD_CAP ? '99 or more unread messages' : `${unread} unread`}
              </span>
            </>
          ) : null}
        </span>
      </Link>
    </motion.li>
  );
}
