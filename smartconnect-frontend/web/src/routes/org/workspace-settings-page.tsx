import { Button } from '@smartconnect/ui/components/button';
import { Input, Select, Textarea } from '@smartconnect/ui/components/input';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { PageContainer, PageHeader } from '@/components/page';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import { useToast } from '@/components/toast/toaster';
import type { Workspace } from '@/lib/api/types';
import { useRequiredOrg } from '@/lib/queries/orgs';
import { useUpdateWorkspace, useWorkspace } from '@/lib/queries/workspaces';

export function WorkspaceSettingsPage() {
  const org = useRequiredOrg();
  const { workspaceId } = useParams({ from: '/app/o/$orgSlugOrId/w/$workspaceId/settings' });
  const workspace = useWorkspace(org.id, workspaceId);
  return (
    <QueryState query={workspace} label="the workspace">
      {(data) =>
        data.myRole === 'admin' ? (
          <SettingsForm workspace={data} />
        ) : (
          <EmptyState
            icon={ShieldAlert}
            title="Administrators only"
            description="Only workspace administrators can change its settings."
          />
        )
      }
    </QueryState>
  );
}

function SettingsForm({ workspace }: { workspace: Workspace }) {
  const org = useRequiredOrg();
  const toast = useToast();
  const update = useUpdateWorkspace(org.id, workspace.id);
  const { formProps, errors, formError, pending } = useForm({
    fields: ['name', 'description', 'visibility'],
    validate: (values) => ({ name: values.name.trim() ? undefined : 'Enter a name.' }),
    submit: async (values) => {
      await update.mutateAsync({
        name: values.name.trim(),
        description: values.description.trim() || null,
        visibility: values.visibility === 'private' ? 'private' : 'open',
      });
      toast({ title: 'Workspace settings saved' });
    },
  });
  return (
    <PageContainer>
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link to="/o/$orgSlugOrId/w/$workspaceId" params={{ orgSlugOrId: org.slug, workspaceId: workspace.id }}>
          <ArrowLeft aria-hidden="true" />
          Back to {workspace.name}
        </Link>
      </Button>
      <PageHeader title="Workspace settings" description={workspace.name} />
      <form {...formProps} aria-label="Workspace settings" className="flex flex-col gap-4">
        <FormError message={formError} />
        <Field label="Name" error={errors.name}>
          {(control) => (
            <Input {...control} name="name" maxLength={80} autoComplete="off" defaultValue={workspace.name} />
          )}
        </Field>
        <Field label="Description (optional)" error={errors.description}>
          {(control) => (
            <Textarea
              {...control}
              name="description"
              rows={3}
              maxLength={1000}
              defaultValue={workspace.description ?? ''}
            />
          )}
        </Field>
        <Field
          label="Visibility"
          hint="Open workspaces can be joined by any organization member. Private ones are by invitation."
          error={errors.visibility}
        >
          {(control) => (
            <Select {...control} name="visibility" defaultValue={workspace.visibility}>
              <option value="open">Open</option>
              <option value="private">Private</option>
            </Select>
          )}
        </Field>
        <div>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </form>
    </PageContainer>
  );
}
