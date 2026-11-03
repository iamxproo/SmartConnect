import { Badge } from '@smartconnect/ui/components/badge';
import { Button } from '@smartconnect/ui/components/button';
import { Input, Select } from '@smartconnect/ui/components/input';
import { Link, useParams, useRouter } from '@tanstack/react-router';
import { Hash, Lock, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog';
import { Field } from '@/components/form/field';
import { FormDialog } from '@/components/form/form-dialog';
import { RevealItem } from '@/components/motion/reveal';
import { PageContainer, PageHeader } from '@/components/page';
import { PeopleList } from '@/components/people-list';
import { QueryState } from '@/components/states/query-state';
import { useToast } from '@/components/toast/toaster';
import { describeError } from '@/lib/api/messages';
import type { Channel, Workspace } from '@/lib/api/types';
import { useRequiredOrg } from '@/lib/queries/orgs';
import {
  useChannels,
  useCreateChannel,
  useJoinChannel,
  useJoinWorkspace,
  useLeaveWorkspace,
  useRemoveWorkspaceMember,
  useSetWorkspaceMember,
  useWorkspace,
  useWorkspaceMembers,
} from '@/lib/queries/workspaces';

export function WorkspacePage() {
  const org = useRequiredOrg();
  const { workspaceId } = useParams({ from: '/app/o/$orgSlugOrId/w/$workspaceId/' });
  const workspace = useWorkspace(org.id, workspaceId);
  return (
    <QueryState query={workspace} label="the workspace">
      {(data) => <WorkspaceDetails workspace={data} />}
    </QueryState>
  );
}

function WorkspaceDetails({ workspace }: { workspace: Workspace }) {
  const org = useRequiredOrg();
  const router = useRouter();
  const toast = useToast();
  const join = useJoinWorkspace(org.id);
  const leave = useLeaveWorkspace(org.id);
  const [leaving, setLeaving] = useState(false);
  const isMember = workspace.myRole !== null;

  return (
    <PageContainer>
      <PageHeader
        title={workspace.name}
        description={workspace.description ?? undefined}
        actions={
          isMember ? (
            <>
              <CreateChannelDialog workspaceId={workspace.id} />
              {workspace.myRole === 'admin' ? (
                <Button asChild variant="outline" size="sm">
                  <Link
                    to="/o/$orgSlugOrId/w/$workspaceId/settings"
                    params={{ orgSlugOrId: org.slug, workspaceId: workspace.id }}
                  >
                    <Settings aria-hidden="true" />
                    Settings
                  </Link>
                </Button>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => setLeaving(true)}>
                Leave workspace
              </Button>
            </>
          ) : workspace.visibility === 'open' ? (
            <Button
              size="sm"
              disabled={join.isPending}
              onClick={() =>
                join.mutate(workspace.id, {
                  onSuccess: () => toast({ title: `Joined ${workspace.name}` }),
                  onError: (error) =>
                    toast({ title: "Couldn't join", description: describeError(error), tone: 'error' }),
                })
              }
            >
              Join workspace
            </Button>
          ) : null
        }
      />
      <div className="flex flex-wrap gap-1.5">
        <Badge>{workspace.visibility === 'open' ? 'Open' : 'Private'}</Badge>
        {workspace.myRole ? <Badge>{`You: ${workspace.myRole}`}</Badge> : null}
        {workspace.archivedAt ? <Badge>Archived</Badge> : null}
      </div>
      {isMember ? (
        <>
          <ChannelsSection workspaceId={workspace.id} />
          <MembersSection workspaceId={workspace.id} isAdmin={workspace.myRole === 'admin'} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Join this workspace to see its channels and members.</p>
      )}
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={`Leave ${workspace.name}?`}
        description="You will lose access to its channels."
        confirmLabel="Leave workspace"
        onConfirm={async () => {
          await leave.mutateAsync(workspace.id);
          toast({ title: `Left ${workspace.name}` });
          void router.navigate({ to: '/o/$orgSlugOrId/workspaces', params: { orgSlugOrId: org.slug } });
        }}
      />
    </PageContainer>
  );
}

function ChannelsSection({ workspaceId }: { workspaceId: string }) {
  const org = useRequiredOrg();
  const channels = useChannels(org.id, workspaceId);
  return (
    <section aria-labelledby="channels-heading" className="flex flex-col gap-3">
      <h3 id="channels-heading" className="font-medium">
        Channels
      </h3>
      <QueryState query={channels} label="channels">
        {(list) =>
          list.length === 0 ? (
            <p className="text-sm text-muted-foreground">No channels yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {list.map((channel, index) => (
                <RevealItem key={channel.id} index={index}>
                  <ChannelRow workspaceId={workspaceId} channel={channel} />
                </RevealItem>
              ))}
            </ul>
          )
        }
      </QueryState>
    </section>
  );
}

function ChannelRow({ workspaceId, channel }: { workspaceId: string; channel: Channel }) {
  const org = useRequiredOrg();
  const toast = useToast();
  const join = useJoinChannel(org.id, workspaceId);
  const Icon = channel.type === 'private' ? Lock : Hash;
  return (
    <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
      <Link
        to="/o/$orgSlugOrId/w/$workspaceId/c/$channelId"
        params={{ orgSlugOrId: org.slug, workspaceId, channelId: channel.id }}
        className="min-w-0 flex-1 truncate font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {channel.name}
      </Link>
      {channel.topic ? (
        <span className="hidden truncate text-sm text-muted-foreground sm:block">{channel.topic}</span>
      ) : null}
      {channel.isMember ? (
        <Badge>Joined</Badge>
      ) : (
        <Button
          size="sm"
          variant="outline"
          aria-label={`Join ${channel.name}`}
          disabled={join.isPending}
          onClick={() =>
            join.mutate(channel.id, {
              onSuccess: () => toast({ title: `Joined #${channel.name}` }),
              onError: (error) => toast({ title: "Couldn't join", description: describeError(error), tone: 'error' }),
            })
          }
        >
          Join
        </Button>
      )}
    </div>
  );
}

function MembersSection({ workspaceId, isAdmin }: { workspaceId: string; isAdmin: boolean }) {
  const org = useRequiredOrg();
  const members = useWorkspaceMembers(org.id, workspaceId, true);
  const set = useSetWorkspaceMember(org.id, workspaceId);
  const remove = useRemoveWorkspaceMember(org.id, workspaceId);
  return (
    <section aria-labelledby="workspace-members-heading" className="flex flex-col gap-3">
      <h3 id="workspace-members-heading" className="font-medium">
        Members
      </h3>
      <QueryState query={members} label="workspace members">
        {(list) => (
          <PeopleList
            orgId={org.id}
            people={list}
            manage={{
              canAdd: isAdmin,
              canRemove: isAdmin,
              roles: ['admin', 'member', 'guest'],
              defaultRole: 'member',
              onSet: (userId, role) => set.mutateAsync({ userId, role }),
              onRemove: (userId) => remove.mutateAsync(userId),
            }}
          />
        )}
      </QueryState>
    </section>
  );
}

function CreateChannelDialog({ workspaceId }: { workspaceId: string }) {
  const org = useRequiredOrg();
  const router = useRouter();
  const toast = useToast();
  const create = useCreateChannel(org.id, workspaceId);
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <Plus aria-hidden="true" />
          New channel
        </Button>
      }
      title="New channel"
      description="You become the channel's administrator."
      submitLabel="Create channel"
      fields={['name', 'topic', 'type']}
      validate={(values) => ({ name: values.name.trim() ? undefined : 'Enter a channel name.' })}
      messages={{ channel_name_taken: 'A channel with that name already exists in this workspace.' }}
      submit={async (values) => {
        const channel = await create.mutateAsync({
          name: values.name.trim(),
          ...(values.topic.trim() ? { topic: values.topic.trim() } : {}),
          type: values.type === 'private' ? 'private' : 'public',
        });
        toast({ title: `#${channel.name} was created` });
        void router.navigate({
          to: '/o/$orgSlugOrId/w/$workspaceId/c/$channelId',
          params: { orgSlugOrId: org.slug, workspaceId, channelId: channel.id },
        });
      }}
    >
      {(errors) => (
        <>
          <Field label="Channel name" error={errors.name}>
            {(control) => <Input {...control} name="name" maxLength={80} autoComplete="off" />}
          </Field>
          <Field label="Topic (optional)" error={errors.topic}>
            {(control) => <Input {...control} name="topic" autoComplete="off" />}
          </Field>
          <Field label="Type" hint="Private channels are visible only to their members." error={errors.type}>
            {(control) => (
              <Select {...control} name="type" defaultValue="public">
                <option value="public">Public</option>
                <option value="private">Private</option>
              </Select>
            )}
          </Field>
        </>
      )}
    </FormDialog>
  );
}
