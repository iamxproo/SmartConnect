import { Button } from '@smartconnect/ui/components/button';
import { Input, Textarea } from '@smartconnect/ui/components/input';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { Card, PageContainer, PageHeader } from '@/components/page';
import { QueryState } from '@/components/states/query-state';
import { useToast } from '@/components/toast/toaster';
import type { Organization } from '@/lib/api/types';
import { useCan, useOrganization, useRequiredOrg, useUpdateOrganization } from '@/lib/queries/orgs';

export function OrgSettingsPage() {
  const org = useRequiredOrg();
  const details = useOrganization(org.id);
  const canUpdate = useCan(org.id, 'organization.update');
  return (
    <PageContainer>
      <PageHeader
        title="Organization settings"
        description={canUpdate ? 'Name, description and invitation rules.' : 'Only administrators can change these.'}
      />
      <QueryState query={details} label="the organization">
        {(organization) => (canUpdate ? <SettingsForm organization={organization} /> : <ReadOnly org={organization} />)}
      </QueryState>
    </PageContainer>
  );
}

function ReadOnly({ org }: { org: Organization }) {
  return (
    <Card>
      <dl className="grid gap-3 text-sm sm:grid-cols-[12rem_1fr]">
        <dt className="text-muted-foreground">Name</dt>
        <dd>{org.name}</dd>
        <dt className="text-muted-foreground">Description</dt>
        <dd>{org.description ?? 'None'}</dd>
        <dt className="text-muted-foreground">Invitations expire after</dt>
        <dd>{org.settings.invitationExpiryDays === 1 ? '1 day' : `${org.settings.invitationExpiryDays} days`}</dd>
      </dl>
    </Card>
  );
}

function SettingsForm({ organization }: { organization: Organization }) {
  const toast = useToast();
  const update = useUpdateOrganization(organization.id);
  const { formProps, errors, formError, pending } = useForm({
    fields: ['name', 'description', 'invitationExpiryDays'],
    validate: (values) => {
      const days = Number(values.invitationExpiryDays);
      return {
        name: values.name.trim() ? undefined : 'Enter a name.',
        invitationExpiryDays:
          values.invitationExpiryDays.trim() && Number.isInteger(days) && days >= 1 && days <= 30
            ? undefined
            : 'Enter a whole number of days from 1 to 30.',
      };
    },
    submit: async (values) => {
      await update.mutateAsync({
        name: values.name.trim(),
        description: values.description.trim() || null,
        settings: { invitationExpiryDays: Number(values.invitationExpiryDays) },
      });
      toast({ title: 'Organization settings saved' });
    },
  });
  return (
    <form {...formProps} aria-label="Organization settings" className="flex flex-col gap-4">
      <FormError message={formError} />
      <Field label="Name" error={errors.name}>
        {(control) => (
          <Input {...control} name="name" maxLength={120} autoComplete="off" defaultValue={organization.name} />
        )}
      </Field>
      <Field label="Description (optional)" error={errors.description}>
        {(control) => (
          <Textarea
            {...control}
            name="description"
            rows={3}
            maxLength={1000}
            defaultValue={organization.description ?? ''}
          />
        )}
      </Field>
      <Field
        label="Invitations expire after (days)"
        hint="Applies to invitations sent from now on. Between 1 and 30."
        error={errors.invitationExpiryDays}
      >
        {(control) => (
          <Input
            {...control}
            name="invitationExpiryDays"
            type="number"
            inputMode="numeric"
            min={1}
            max={30}
            className="w-32"
            defaultValue={organization.settings.invitationExpiryDays}
          />
        )}
      </Field>
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}
