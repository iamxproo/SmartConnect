import { Button } from '@smartconnect/ui/components/button';
import { Link } from '@tanstack/react-router';
import { Bookmark, Hash, MessagesSquare } from 'lucide-react';
import { useMemo } from 'react';
import { MessageText } from '@/components/messages/message-body';
import { Card, PageContainer, PageHeader } from '@/components/page';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { LoadingState } from '@/components/states/loading-state';
import { useToast } from '@/components/toast/toaster';
import { describeError } from '@/lib/api/messages';
import type { SavedMessage } from '@/lib/api/types';
import { useUser } from '@/lib/auth';
import { useSavedMessages, useUnsave } from '@/lib/queries/message-actions';
import { useMembers, useRequiredOrg } from '@/lib/queries/orgs';
import { useChannel } from '@/lib/queries/workspaces';
import { formatRelative } from '@/lib/relative-time';

/** `/o/$org/saved`: the messages the signed-in person saved and can still see. */
export function SavedPage() {
  const org = useRequiredOrg();
  const user = useUser();
  const toast = useToast();
  const saved = useSavedMessages(org.id);
  const directory = useMembers(org.id);
  const unsave = useUnsave(org.id);
  const names = useMemo(() => new Map(directory.data?.map((m) => [m.userId, m.displayName])), [directory.data]);
  const nameOf = (userId: string | null) => (userId && names.get(userId)) || 'Former member';
  const items = saved.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Saved messages"
        description="Messages you saved for later. Only the ones you can still see are listed."
      />
      {saved.isPending ? <LoadingState label="Loading saved messages" /> : null}
      {saved.isError ? (
        <ErrorState
          title="Couldn't load saved messages"
          description={describeError(saved.error)}
          details={saved.error.message}
          onRetry={() => void saved.refetch()}
        />
      ) : null}
      {saved.isSuccess && items.length === 0 ? (
        <EmptyState
          icon={Bookmark}
          title="Nothing saved yet"
          description="Open the actions menu of a message and choose Save message to keep it here."
        />
      ) : null}
      {items.length > 0 ? (
        <ul aria-label="Saved messages" className="flex flex-col gap-3">
          {items.map((message) => (
            <li key={message.id}>
              <Card className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <Where message={message} />
                  <span className="text-xs text-muted-foreground">Saved {formatRelative(message.savedAt)}</span>
                </div>
                <p className="text-sm">
                  <span className="font-medium">{nameOf(message.senderUserId)}</span>{' '}
                  <time dateTime={message.createdAt} className="text-xs text-muted-foreground">
                    {formatRelative(message.createdAt)}
                  </time>
                </p>
                <MessageText selfId={user.id} nameOf={(userId) => nameOf(userId)}>
                  {message.body ?? ''}
                </MessageText>
                <div className="flex gap-2">
                  <OpenLink message={message} />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={unsave.isPending}
                    onClick={() =>
                      unsave.mutate(message, {
                        onError: (error) =>
                          toast({ title: "Couldn't remove it", description: describeError(error), tone: 'error' }),
                      })
                    }
                  >
                    Remove from saved
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
      {saved.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          disabled={saved.isFetchingNextPage}
          onClick={() => void saved.fetchNextPage()}
        >
          {saved.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </PageContainer>
  );
}

/** Where the message lives: the channel's name, or the kind of conversation. */
function Where({ message }: { message: SavedMessage }) {
  if (message.kind === 'channel' && message.workspaceId && message.channelId) {
    return <ChannelName message={message} />;
  }
  return (
    <span className="inline-flex items-center gap-1.5 font-medium">
      <MessagesSquare className="size-4 text-muted-foreground" aria-hidden="true" />
      {message.kind === 'group' ? 'Group conversation' : 'Direct message'}
    </span>
  );
}

function ChannelName({ message }: { message: SavedMessage }) {
  const org = useRequiredOrg();
  const channel = useChannel(org.id, message.workspaceId ?? '', message.channelId ?? '');
  return (
    <span className="inline-flex items-center gap-1.5 font-medium">
      <Hash className="size-4 text-muted-foreground" aria-hidden="true" />
      {channel.data?.name ?? 'Channel'}
    </span>
  );
}

function OpenLink({ message }: { message: SavedMessage }) {
  const org = useRequiredOrg();
  const hash = `message-${message.id}`;
  return (
    <Button asChild size="sm" variant="outline">
      {message.channelId && message.workspaceId ? (
        <Link
          to="/o/$orgSlugOrId/w/$workspaceId/c/$channelId"
          params={{ orgSlugOrId: org.slug, workspaceId: message.workspaceId, channelId: message.channelId }}
          hash={hash}
        >
          Open in channel
        </Link>
      ) : (
        <Link
          to="/o/$orgSlugOrId/messages/$conversationId"
          params={{ orgSlugOrId: org.slug, conversationId: message.conversationId }}
          hash={hash}
        >
          Open conversation
        </Link>
      )}
    </Button>
  );
}
