import { cn } from '@smartconnect/ui/lib/utils';
import { useRouter } from '@tanstack/react-router';
import { AtSign, Hash, MessageSquareReply, MessagesSquare } from 'lucide-react';
import type { MouseEvent } from 'react';
import { MessageText } from '@/components/messages/message-body';
import type { ActivityItem } from '@/lib/queries/activity';
import { useRequiredOrg } from '@/lib/queries/orgs';
import { useChannel } from '@/lib/queries/workspaces';
import { formatRelative } from '@/lib/relative-time';

/** Where opening the item leads: the channel or conversation, with the message to show in `?message=`. */
export function activityHref(orgSlug: string, item: ActivityItem): string {
  const { location, message } = item;
  const base =
    location.kind === 'channel'
      ? `/o/${orgSlug}/w/${location.workspaceId}/c/${location.channelId}`
      : `/o/${orgSlug}/messages/${location.conversationId}`;
  return `${base}?message=${encodeURIComponent(message.id)}`;
}

interface ActivityRowProps {
  item: ActivityItem;
  nameOf: (userId: string | null) => string;
  selfId: string;
  onOpen: (item: ActivityItem) => void;
}

export function ActivityRow({ item, nameOf, selfId, onOpen }: ActivityRowProps) {
  const org = useRequiredOrg();
  const router = useRouter();
  const href = activityHref(org.slug, item);
  const sender = nameOf(item.message.senderUserId);
  const what = item.kind === 'mention' ? 'mentioned you' : 'replied in a thread';
  const Icon = item.kind === 'mention' ? AtSign : MessageSquareReply;

  function open(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    onOpen(item);
    router.history.push(href);
  }

  return (
    <li>
      <a
        href={href}
        onClick={open}
        className={cn(
          'flex gap-3 rounded-lg border border-border p-3 text-sm transition-colors duration-(--sc-duration-fast) ease-standard',
          'hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
          item.unread && 'bg-surface-selected',
        )}
      >
        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-2">
            <span className={cn(item.unread ? 'font-semibold' : 'font-medium')}>
              {sender} <span className="font-normal text-muted-foreground">{what}</span>
              {item.unread ? <span className="sr-only"> (unread)</span> : null}
            </span>
            <time dateTime={item.message.createdAt} className="text-xs text-muted-foreground">
              {formatRelative(item.message.createdAt)}
            </time>
          </span>
          <Where item={item} />
          <span className="min-w-0 text-muted-foreground">
            <MessageText selfId={selfId} nameOf={(userId) => nameOf(userId)}>
              {item.message.excerpt}
            </MessageText>
          </span>
        </span>
      </a>
    </li>
  );
}

function Where({ item }: { item: ActivityItem }) {
  const { location } = item;
  if (location.kind === 'channel')
    return <ChannelName workspaceId={location.workspaceId} channelId={location.channelId} />;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <MessagesSquare className="size-3" aria-hidden="true" />
      {location.kind === 'group' ? 'Group conversation' : 'Direct message'}
    </span>
  );
}

function ChannelName({ workspaceId, channelId }: { workspaceId: string; channelId: string }) {
  const org = useRequiredOrg();
  const channel = useChannel(org.id, workspaceId, channelId);
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Hash className="size-3" aria-hidden="true" />
      {channel.data?.name ?? 'Channel'}
    </span>
  );
}
