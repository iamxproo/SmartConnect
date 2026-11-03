import { Button } from '@smartconnect/ui/components/button';
import { Bell, CheckCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ActivityRow } from '@/components/activity/activity-item';
import { PageContainer, PageHeader } from '@/components/page';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { LoadingState } from '@/components/states/loading-state';
import { useToast } from '@/components/toast/toaster';
import { describeError } from '@/lib/api/messages';
import { useUser } from '@/lib/auth';
import {
  useActivity,
  useMarkActivityRead,
  useMarkAllActivityRead,
  useUnreadActivityCount,
  type ActivityFilter,
  type ActivityItem,
} from '@/lib/queries/activity';
import { useMemberNames } from '@/lib/queries/conversations';
import { useRequiredOrg } from '@/lib/queries/orgs';

const filters: { value: ActivityFilter; label: string; empty: string }[] = [
  { value: 'all', label: 'All', empty: 'Mentions of you and replies in threads you take part in show up here.' },
  { value: 'unread', label: 'Unread', empty: "You're all caught up." },
  { value: 'mentions', label: 'Mentions', empty: 'Nobody has mentioned you yet.' },
  { value: 'threads', label: 'Threads', empty: 'No replies in your threads yet.' },
];

const MENTION = /<@([^>\s]+)>/g;

/** `/o/$org/activity`: mentions of the signed-in person and replies in threads they take part in. */
export function ActivityPage() {
  const org = useRequiredOrg();
  const user = useUser();
  const toast = useToast();
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const activity = useActivity(org.id, filter);
  const unread = useUnreadActivityCount(org.id, false).data ?? 0;
  const markRead = useMarkActivityRead(org.id);
  const markAll = useMarkAllActivityRead(org.id);
  const items = useMemo(() => activity.data?.pages.flatMap((page) => page.data) ?? [], [activity.data]);
  const userIds = useMemo(
    () =>
      items
        .flatMap((i) => [i.message.senderUserId ?? '', ...[...i.message.excerpt.matchAll(MENTION)].map((m) => m[1]!)])
        .filter(Boolean),
    [items],
  );
  const nameOf = useMemberNames(org.id, userIds);
  const current = filters.find((f) => f.value === filter)!;

  function open(item: ActivityItem) {
    if (item.unread) markRead.mutate([item.id]);
  }

  return (
    <PageContainer>
      <PageHeader
        title="Activity"
        description="Mentions of you and replies in threads you take part in. Only what you can still see is listed."
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={unread === 0 || markAll.isPending}
            onClick={() =>
              markAll.mutate(undefined, {
                onError: (error) =>
                  toast({ title: "Couldn't mark all as read", description: describeError(error), tone: 'error' }),
              })
            }
          >
            <CheckCheck aria-hidden="true" />
            Mark all as read
          </Button>
        }
      />
      <div role="group" aria-label="Filter activity" className="flex flex-wrap gap-1">
        {filters.map(({ value, label }) => (
          <Button
            key={value}
            size="sm"
            variant={filter === value ? 'default' : 'outline'}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </Button>
        ))}
      </div>
      {activity.isPending ? <LoadingState label="Loading activity" /> : null}
      {activity.isError ? (
        <ErrorState
          title="Couldn't load activity"
          description={describeError(activity.error)}
          details={activity.error.message}
          onRetry={() => void activity.refetch()}
        />
      ) : null}
      {activity.isSuccess && items.length === 0 ? (
        <EmptyState icon={Bell} title="Nothing here" description={current.empty} />
      ) : null}
      {items.length > 0 ? (
        <ul aria-label="Activity" className="flex flex-col gap-2">
          {items.map((item) => (
            <ActivityRow key={item.id} item={item} nameOf={nameOf} selfId={user.id} onOpen={open} />
          ))}
        </ul>
      ) : null}
      {activity.hasNextPage ? (
        <Button
          variant="outline"
          className="self-center"
          disabled={activity.isFetchingNextPage}
          onClick={() => void activity.fetchNextPage()}
        >
          {activity.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      ) : null}
    </PageContainer>
  );
}
