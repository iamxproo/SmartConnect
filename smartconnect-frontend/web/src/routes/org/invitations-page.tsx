import { Badge } from '@smartconnect/ui/components/badge';
import { Button } from '@smartconnect/ui/components/button';
import { Input, Select } from '@smartconnect/ui/components/input';
import { Lock, MailPlus } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { RevealItem } from '@/components/motion/reveal';
import { PageContainer, PageHeader } from '@/components/page';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import { useToast } from '@/components/toast/toaster';
import { describeError } from '@/lib/api/messages';
import type { Invitation, InvitationStatus } from '@/lib/api/types';
import {
  useCan,
  useInvitations,
  useRequiredOrg,
  useResendInvitation,
  useRevokeInvitation,
  useRoles,
  useSendInvitation,
} from '@/lib/queries/orgs';
import { isEmail } from '@/lib/validation';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export function InvitationsPage() {
  const org = useRequiredOrg();
  const canInvite = useCan(org.id, 'members.invite');
  if (!canInvite) {
    return (
      <EmptyState
        icon={Lock}
        title="Invitations are managed by administrators"
        description="You don't have permission to invite people to this organization."
      />
    );
  }
  return (
    <PageContainer>
      <PageHeader
        title="Invitations"
        description="People join this company only through an invitation sent to their email address."
      />
      <InviteForm />
      <InvitationList />
    </PageContainer>
  );
}

function InviteForm() {
  const org = useRequiredOrg();
  const toast = useToast();
  const roles = useRoles(org.id);
  const send = useSendInvitation(org.id);
  const { formProps, errors, formError, pending } = useForm({
    fields: ['email', 'roleId'],
    validate: (values) => ({
      email: isEmail(values.email) ? undefined : 'Enter a valid email address.',
      roleId: values.roleId ? undefined : 'Choose a role.',
    }),
    submit: async (values) => {
      await send.mutateAsync({ email: values.email.trim(), roleId: values.roleId });
      toast({ title: 'Invitation sent', description: values.email.trim() });
      formRef.current?.reset();
    },
  });
  const formRef = formProps.ref;

  return (
    <form
      {...formProps}
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
      aria-label="Invite someone"
    >
      <FormError message={formError} />
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-start">
        <Field label="Email address" error={errors.email}>
          {(control) => <Input {...control} name="email" type="email" autoComplete="off" />}
        </Field>
        <Field label="Role" error={errors.roleId}>
          {(control) => (
            <Select {...control} name="roleId" defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {roles.data?.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Button type="submit" disabled={pending} className="sm:mt-[1.625rem]">
          <MailPlus aria-hidden="true" />
          {pending ? 'Sending…' : 'Send invitation'}
        </Button>
      </div>
    </form>
  );
}

function InvitationList() {
  const org = useRequiredOrg();
  const [status, setStatus] = useState<InvitationStatus | ''>('');
  const invitations = useInvitations(org.id, status);
  return (
    <section aria-labelledby="invitation-list-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 id="invitation-list-heading" className="font-medium">
          Sent invitations
        </h3>
        <Select
          aria-label="Filter by status"
          className="w-40"
          value={status}
          onChange={(event) => setStatus(event.target.value as InvitationStatus | '')}
        >
          <option value="">All</option>
          <option value="pending">Pending</option>
          <option value="accepted">Accepted</option>
          <option value="expired">Expired</option>
          <option value="revoked">Revoked</option>
        </Select>
      </div>
      <QueryState query={invitations} label="invitations">
        {(list) =>
          list.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invitations to show.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {list.map((invitation, index) => (
                <RevealItem key={invitation.id} index={index}>
                  <InvitationRow invitation={invitation} />
                </RevealItem>
              ))}
            </ul>
          )
        }
      </QueryState>
    </section>
  );
}

function InvitationRow({ invitation }: { invitation: Invitation }) {
  const org = useRequiredOrg();
  const toast = useToast();
  const resend = useResendInvitation(org.id);
  const revoke = useRevokeInvitation(org.id);
  const [revoking, setRevoking] = useState(false);
  const open = invitation.status === 'pending' || invitation.status === 'expired';

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{invitation.email}</p>
        <p className="text-xs text-muted-foreground">
          {invitation.role.name} · {invitation.status === 'pending' ? 'expires' : 'expired'}{' '}
          {dateFormat.format(new Date(invitation.expiresAt))}
        </p>
      </div>
      <Badge>{invitation.status}</Badge>
      {open ? (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Resend invitation to ${invitation.email}`}
          disabled={resend.isPending}
          onClick={() =>
            resend.mutate(invitation.id, {
              onSuccess: () => toast({ title: 'Invitation resent', description: 'The previous link no longer works.' }),
              onError: (error) => toast({ title: "Couldn't resend", description: describeError(error), tone: 'error' }),
            })
          }
        >
          Resend
        </Button>
      ) : null}
      {invitation.status === 'pending' ? (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Revoke invitation for ${invitation.email}`}
          onClick={() => setRevoking(true)}
        >
          Revoke
        </Button>
      ) : null}
      <ConfirmDialog
        open={revoking}
        onOpenChange={setRevoking}
        title="Revoke this invitation?"
        description={`${invitation.email} will no longer be able to join with this invitation.`}
        confirmLabel="Revoke invitation"
        onConfirm={async () => {
          await revoke.mutateAsync(invitation.id);
          toast({ title: 'Invitation revoked' });
        }}
      />
    </div>
  );
}
