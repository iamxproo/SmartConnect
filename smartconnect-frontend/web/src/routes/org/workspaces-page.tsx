import { Badge } from '@smartconnect/ui/components/badge';
import { Button } from '@smartconnect/ui/components/button';
import { Input, Select } from '@smartconnect/ui/components/input';
import { Link, useRouter } from '@tanstack/react-router';
import { Boxes, Plus } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog';
import { Field } from '@/components/form/field';
import { FormDialog } from '@/components/form/form-dialog';
import { NameSlugFields } from '@/components/form/name-slug-fields';
import { RevealItem } from '@/components/motion/reveal';
import { Card, PageContainer, PageHeader } from '@/components/page';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import { useToast } from '@/components/toast/toaster';
import { describeError } from '@/lib/api/messages';
import type { Workspace } from '@/lib/api/types';
import { useCan, useRequiredOrg } from '@/lib/queries/orgs';
import { useCreateWorkspace, useJoinWorkspace, useLeaveWorkspace, useWorkspaces } from '@/lib/queries/workspaces';

export function WorkspacesPage() {
  const org = useRequiredOrg();
  const workspaces = useWorkspaces(org.id);
  const canCreate = useCan(org.id, 'workspaces.create');

  return (
    <PageContainer>
      <PageHeader
        title="Workspaces"
        description="Open workspaces you can join, and the private ones you belong to."
        actions={canCreate ? <CreateWorkspaceDialog /> : null}
      />
      <QueryState query={workspaces} label="workspaces">
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="No workspaces yet"
              description={
                canCreate
                  ? 'Create the first workspace for your company.'
                  : 'There are no open workspaces, and you have not been added to a private one. Workspaces are created by authorized members.'
              }
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {list.map((workspace, index) => (
                <RevealItem key={workspace.id} index={index} hoverLift>
                  <WorkspaceCard workspace={workspace} />
                </RevealItem>
              ))}
            </ul>
          )
        }
      </QueryState>
    </PageContainer>
  );
}

function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const org = useRequiredOrg();
  const router = useRouter();
  const toast = useToast();
  const join = useJoinWorkspace(org.id);
  const leave = useLeaveWorkspace(org.id);
  const [leaving, setLeaving] = useState(false);
  const params = { orgSlugOrId: org.slug, workspaceId: workspace.id };

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">{workspace.name}</h3>
          {workspace.description ? <p className="text-sm text-muted-foreground">{workspace.description}</p> : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge>{workspace.visibility === 'open' ? 'Open' : 'Private'}</Badge>
            {workspace.myRole ? <Badge>{`You: ${workspace.myRole}`}</Badge> : null}
            {workspace.archivedAt ? <Badge>Archived</Badge> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {workspace.myRole ? (
            <>
              <Button asChild size="sm">
                <Link to="/o/$orgSlugOrId/w/$workspaceId" params={params} aria-label={`Open ${workspace.name}`}>
                  Open
                </Link>
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label={`Leave ${workspace.name}`}
                onClick={() => setLeaving(true)}
              >
                Leave
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              aria-label={`Join ${workspace.name}`}
              disabled={join.isPending}
              onClick={() =>
                join.mutate(workspace.id, {
                  onSuccess: () => {
                    toast({ title: `Joined ${workspace.name}` });
                    void router.navigate({ to: '/o/$orgSlugOrId/w/$workspaceId', params });
                  },
                  onError: (error) =>
                    toast({
                      title: `Couldn't join ${workspace.name}`,
                      description: describeError(error),
                      tone: 'error',
                    }),
                })
              }
            >
              Join
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title={`Leave ${workspace.name}?`}
        description="You will lose access to its channels. For an open workspace you can join again later."
        confirmLabel="Leave workspace"
        onConfirm={async () => {
          await leave.mutateAsync(workspace.id);
          toast({ title: `Left ${workspace.name}` });
        }}
      />
    </Card>
  );
}

function CreateWorkspaceDialog() {
  const org = useRequiredOrg();
  const router = useRouter();
  const toast = useToast();
  const create = useCreateWorkspace(org.id);
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <Plus aria-hidden="true" />
          New workspace
        </Button>
      }
      title="New workspace"
      description="You become its administrator. A public #general channel is created for you."
      submitLabel="Create workspace"
      fields={['name', 'slug', 'description', 'visibility']}
      validate={(values) => ({
        name: values.name.trim() ? undefined : 'Enter a name.',
        slug: values.slug.trim() ? undefined : 'Enter an address.',
      })}
      submit={async (values) => {
        const workspace = await create.mutateAsync({
          name: values.name.trim(),
          slug: values.slug.trim(),
          ...(values.description.trim() ? { description: values.description.trim() } : {}),
          visibility: values.visibility === 'private' ? 'private' : 'open',
        });
        toast({ title: `${workspace.name} was created` });
        void router.navigate({
          to: '/o/$orgSlugOrId/w/$workspaceId',
          params: { orgSlugOrId: org.slug, workspaceId: workspace.id },
        });
      }}
    >
      {(errors) => (
        <>
          <NameSlugFields errors={errors} nameLabel="Workspace name" />
          <Field label="Description (optional)" error={errors.description}>
            {(control) => <Input {...control} name="description" autoComplete="off" />}
          </Field>
          <Field
            label="Visibility"
            hint="Open workspaces can be joined by any member; private ones only include people a workspace administrator adds."
            error={errors.visibility}
          >
            {(control) => (
              <Select {...control} name="visibility" defaultValue="open">
                <option value="open">Open</option>
                <option value="private">Private</option>
              </Select>
            )}
          </Field>
        </>
      )}
    </FormDialog>
  );
}
