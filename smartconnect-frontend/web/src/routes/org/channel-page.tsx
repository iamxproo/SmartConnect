import { Badge } from '@smartconnect/ui/components/badge';
import { Button } from '@smartconnect/ui/components/button';
import { Link, useParams } from '@tanstack/react-router';
import { Hash, Lock, SearchX } from 'lucide-react';
import { useState } from 'react';
import { NotificationLevelMenu } from '@/components/activity/notification-level-menu';
import { Conversation } from '@/components/messages/conversation';
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog';
import { PageContainer, PageHeader } from '@/components/page';
import { PeopleList } from '@/components/people-list';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import { useToast } from '@/components/toast/toaster';
import { describeError } from '@/lib/api/messages';
import { ApiError } from '@/lib/api/errors';
import type { Channel } from '@/lib/api/types';
import { useFocusedMessage } from '@/lib/use-focused-message';
import { useRequiredOrg } from '@/lib/queries/orgs';
import {
  useChannel,
  useChannelMembers,
  useJoinChannel,
  useLeaveChannel,
  useRemoveChannelMember,
  useSetChannelMember,
} from '@/lib/queries/workspaces';

export function ChannelPage() {
  const org = useRequiredOrg();
  const { workspaceId, channelId } = useParams({ from: '/app/o/$orgSlugOrId/w/$workspaceId/c/$channelId' });
  const channel = useChannel(org.id, workspaceId, channelId);

  if (channel.error instanceof ApiError && channel.error.status === 404) {
    return (
      <EmptyState
        icon={SearchX}
        title="Channel not found"
        description="This channel doesn't exist, or you don't have access to it."
        action={
          <Button asChild variant="outline">
            <Link to="/o/$orgSlugOrId/w/$workspaceId" params={{ orgSlugOrId: org.slug, workspaceId }}>
              Back to the workspace
            </Link>
          </Button>
        }
      />
    );
  }
  return (
    <QueryState query={channel} label="the channel">
      {(data) => <ChannelDetails workspaceId={workspaceId} channel={data} />}
    </QueryState>
  );
}

function ChannelDetails({ workspaceId, channel }: { workspaceId: string; channel: Channel }) {
  const org = useRequiredOrg();
  const toast = useToast();
  const join = useJoinChannel(org.id, workspaceId);
  const leave = useLeaveChannel(org.id, workspaceId);
  const [leaving, setLeaving] = useState(false);
  const focus = useFocusedMessage();
  const Icon = channel.type === 'private' ? Lock : Hash;

  return (
    <PageContainer>
      <PageHeader
        title={`# ${channel.name}`}
        description={channel.topic ?? channel.description ?? undefined}
        actions={
          channel.isMember ? (
            <Button variant="outline" size="sm" onClick={() => setLeaving(true)}>
              Leave channel
            </Button>
          ) : (
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
              Join channel
            </Button>
          )
        }
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        <Badge>{channel.type === 'private' ? 'Private' : 'Public'}</Badge>
        {channel.isDefault ? <Badge>Default</Badge> : null}
        {channel.archivedAt ? <Badge>Archived</Badge> : null}
        <span className="ml-auto">
          <NotificationLevelMenu location={{ kind: 'channel', workspaceId, channelId: channel.id }} />
        </span>
      </div>
      <Conversation
        orgId={org.id}
        workspaceId={workspaceId}
        channel={channel}
        focusMessageId={focus.messageId}
        onFocusClear={focus.clear}
      />
      <section aria-labelledby="channel-members-heading" className="flex flex-col gap-3">
        <h3 id="channel-members-heading" className="font-medium">
          Members
        </h3>
        <ChannelMembers workspaceId={workspaceId} channel={channel} />
      </section>
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={`Leave #${channel.name}?`}
        description={
          channel.type === 'private'
            ? 'This channel is private: you can only return if someone adds you.'
            : 'You can join again later.'
        }
        confirmLabel="Leave channel"
        onConfirm={async () => {
          await leave.mutateAsync(channel.id);
          toast({ title: `Left #${channel.name}` });
        }}
      />
    </PageContainer>
  );
}

function ChannelMembers({ workspaceId, channel }: { workspaceId: string; channel: Channel }) {
  const org = useRequiredOrg();
  const members = useChannelMembers(org.id, workspaceId, channel.id);
  const set = useSetChannelMember(org.id, workspaceId, channel.id);
  const remove = useRemoveChannelMember(org.id, workspaceId, channel.id);
  const isAdmin = channel.myRole === 'admin';
  return (
    <QueryState query={members} label="channel members">
      {(list) => (
        <PeopleList
          orgId={org.id}
          people={list}
          manage={{
            // Public channels: any member may add people. Private ones: channel admins only.
            canAdd: channel.type === 'public' ? channel.isMember : isAdmin,
            canRemove: isAdmin,
            roles: isAdmin ? ['admin', 'member'] : [],
            defaultRole: 'member',
            onSet: (userId, role) => set.mutateAsync({ userId, role }),
            onRemove: (userId) => remove.mutateAsync(userId),
          }}
        />
      )}
    </QueryState>
  );
}
