import { Badge } from '@smartconnect/ui/components/badge';
import { Button } from '@smartconnect/ui/components/button';
import { Input, Select } from '@smartconnect/ui/components/input';
import { ChevronDown, Plus, UsersRound } from 'lucide-react';
import { useId, useState } from 'react';
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog';
import { Field } from '@/components/form/field';
import { FormDialog } from '@/components/form/form-dialog';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { RevealItem } from '@/components/motion/reveal';
import { Card, PageContainer, PageHeader } from '@/components/page';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import { useToast } from '@/components/toast/toaster';
import type { Department, Team, TeamMember } from '@/lib/api/types';
import { useUser } from '@/lib/auth';
import {
  useCreateTeam,
  useDeleteTeam,
  useDepartments,
  useRemoveTeamMember,
  useSetTeamMember,
  useTeamMembers,
  useTeams,
  useUpdateTeam,
} from '@/lib/queries/directory';
import { useCan, useMembers, useRequiredOrg } from '@/lib/queries/orgs';

export function TeamsPage() {
  const org = useRequiredOrg();
  const [departmentId, setDepartmentId] = useState('');
  const departments = useDepartments(org.id);
  const teams = useTeams(org.id, departmentId);
  const canManage = useCan(org.id, 'teams.manage');

  return (
    <PageContainer>
      <PageHeader
        title="Teams"
        description="Public teams, and the private teams you belong to."
        actions={canManage ? <CreateTeamDialog departments={departments.data ?? []} /> : null}
      />
      {departments.data && departments.data.length > 0 ? (
        <Select
          aria-label="Filter by department"
          className="w-56"
          value={departmentId}
          onChange={(event) => setDepartmentId(event.target.value)}
        >
          <option value="">All departments</option>
          {departments.data.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
        </Select>
      ) : null}
      <QueryState query={teams} label="teams">
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              icon={UsersRound}
              title="No teams to show"
              description={
                canManage ? 'Create the first team.' : 'There are no public teams, and you are not in a private one.'
              }
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {list.map((team, index) => (
                <RevealItem key={team.id} index={index} hoverLift>
                  <TeamCard
                    team={team}
                    department={departments.data?.find((item) => item.id === team.departmentId)}
                    departments={departments.data ?? []}
                    canManage={canManage}
                  />
                </RevealItem>
              ))}
            </ul>
          )
        }
      </QueryState>
    </PageContainer>
  );
}

function TeamCard({
  team,
  department,
  departments,
  canManage,
}: {
  team: Team;
  department?: Department;
  departments: Department[];
  canManage: boolean;
}) {
  const org = useRequiredOrg();
  const toast = useToast();
  const remove = useDeleteTeam(org.id);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const panelId = useId();

  return (
    <Card>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">{team.name}</h3>
          {team.description ? <p className="text-sm text-muted-foreground">{team.description}</p> : null}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge>{team.visibility === 'public' ? 'Public' : 'Private'}</Badge>
            <Badge>{team.memberCount === 1 ? '1 member' : `${team.memberCount} members`}</Badge>
            {department ? <Badge>{department.name}</Badge> : null}
            {team.myRole ? <Badge>{`You: ${team.myRole}`}</Badge> : null}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Members of ${team.name}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
        >
          Members
          <ChevronDown
            className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
            aria-hidden="true"
          />
        </Button>
        {canManage ? <EditTeamDialog team={team} departments={departments} /> : null}
        {canManage ? (
          <Button variant="outline" size="sm" aria-label={`Delete ${team.name}`} onClick={() => setDeleting(true)}>
            Delete
          </Button>
        ) : null}
      </div>
      <div id={panelId} hidden={!open} className="mt-4 border-t border-border pt-4">
        {open ? <TeamMembers team={team} canManage={canManage} /> : null}
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${team.name}?`}
        description="This cannot be undone."
        confirmLabel="Delete team"
        onConfirm={async () => {
          await remove.mutateAsync(team.id);
          toast({ title: `${team.name} was deleted` });
        }}
      />
    </Card>
  );
}

function TeamMembers({ team, canManage }: { team: Team; canManage: boolean }) {
  const org = useRequiredOrg();
  const userId = useUser().id;
  const toast = useToast();
  const members = useTeamMembers(org.id, team.id, true);
  const remove = useRemoveTeamMember(org.id, team.id);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const canEdit = canManage || team.myRole === 'lead';

  return (
    <div className="flex flex-col gap-3">
      <QueryState query={members} label="team members">
        {(list) => (
          <ul className="flex flex-col gap-1.5">
            {list.map((member) => {
              const self = member.userId === userId;
              return (
                <li key={member.userId} className="flex items-center gap-3 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {member.displayName}
                    {self ? ' (you)' : ''}
                    <span className="text-muted-foreground"> · {member.email}</span>
                  </span>
                  <Badge>{member.role}</Badge>
                  {canEdit || self ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={self ? `Leave ${team.name}` : `Remove ${member.displayName}`}
                      onClick={() => setRemoving(member)}
                    >
                      {self ? 'Leave' : 'Remove'}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </QueryState>
      {canEdit ? <AddTeamMember teamId={team.id} existing={members.data ?? []} /> : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => !next && setRemoving(null)}
        title={removing?.userId === userId ? `Leave ${team.name}?` : `Remove ${removing?.displayName ?? ''}?`}
        description={
          removing?.userId === userId
            ? 'You will no longer be part of this team.'
            : 'They will no longer be part of this team.'
        }
        confirmLabel={removing?.userId === userId ? 'Leave team' : 'Remove member'}
        onConfirm={async () => {
          if (!removing) return;
          await remove.mutateAsync(removing.userId);
          toast({
            title: removing.userId === userId ? `You left ${team.name}` : `${removing.displayName} was removed`,
          });
        }}
      />
    </div>
  );
}

function AddTeamMember({ teamId, existing }: { teamId: string; existing: TeamMember[] }) {
  const org = useRequiredOrg();
  const toast = useToast();
  const directory = useMembers(org.id);
  const setMember = useSetTeamMember(org.id, teamId);
  const candidates =
    directory.data?.filter((member) => !existing.some((current) => current.userId === member.userId)) ?? [];
  const { formProps, errors, formError, pending } = useForm({
    fields: ['userId', 'role'],
    validate: (values) => ({ userId: values.userId ? undefined : 'Choose a person.' }),
    submit: async (values) => {
      await setMember.mutateAsync({ userId: values.userId, role: values.role === 'lead' ? 'lead' : 'member' });
      toast({ title: 'Team member added' });
    },
  });
  return (
    <form {...formProps} aria-label="Add a team member" className="flex flex-col gap-2">
      <FormError message={formError} />
      <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto] sm:items-start">
        <Field label="Person" error={errors.userId}>
          {(control) => (
            <Select {...control} name="userId" defaultValue="">
              <option value="" disabled>
                Choose…
              </option>
              {candidates.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Role">
          {(control) => (
            <Select {...control} name="role" defaultValue="member">
              <option value="member">Member</option>
              <option value="lead">Lead</option>
            </Select>
          )}
        </Field>
        <Button type="submit" size="sm" disabled={pending} className="sm:mt-[1.625rem]">
          Add
        </Button>
      </div>
    </form>
  );
}

function CreateTeamDialog({ departments }: { departments: Department[] }) {
  const org = useRequiredOrg();
  const toast = useToast();
  const create = useCreateTeam(org.id);
  return (
    <FormDialog
      trigger={
        <Button size="sm">
          <Plus aria-hidden="true" />
          New team
        </Button>
      }
      title="New team"
      submitLabel="Create team"
      fields={['name', 'description', 'departmentId', 'visibility']}
      validate={(values) => ({ name: values.name.trim() ? undefined : 'Enter a name.' })}
      submit={async (values) => {
        await create.mutateAsync({
          name: values.name.trim(),
          ...(values.description.trim() ? { description: values.description.trim() } : {}),
          ...(values.departmentId ? { departmentId: values.departmentId } : {}),
          visibility: values.visibility === 'private' ? 'private' : 'public',
        });
        toast({ title: `${values.name.trim()} was created` });
      }}
    >
      {(errors) => (
        <>
          <Field label="Name" error={errors.name}>
            {(control) => <Input {...control} name="name" maxLength={80} autoComplete="off" />}
          </Field>
          <Field label="Description (optional)" error={errors.description}>
            {(control) => <Input {...control} name="description" autoComplete="off" />}
          </Field>
          <Field label="Department (optional)" error={errors.departmentId}>
            {(control) => (
              <Select {...control} name="departmentId" defaultValue="">
                <option value="">None</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Visibility" error={errors.visibility}>
            {(control) => (
              <Select {...control} name="visibility" defaultValue="public">
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

function EditTeamDialog({ team, departments }: { team: Team; departments: Department[] }) {
  const org = useRequiredOrg();
  const toast = useToast();
  const update = useUpdateTeam(org.id);
  return (
    <FormDialog
      trigger={
        <Button variant="outline" size="sm" aria-label={`Edit ${team.name}`}>
          Edit
        </Button>
      }
      title={`Edit ${team.name}`}
      submitLabel="Save changes"
      fields={['name', 'description', 'departmentId', 'visibility']}
      validate={(values) => ({ name: values.name.trim() ? undefined : 'Enter a name.' })}
      submit={async (values) => {
        await update.mutateAsync({
          id: team.id,
          name: values.name.trim(),
          description: values.description.trim() || null,
          departmentId: values.departmentId || null,
          visibility: values.visibility === 'private' ? 'private' : 'public',
        });
        toast({ title: `${values.name.trim()} was updated` });
      }}
    >
      {(errors) => (
        <>
          <Field label="Name" error={errors.name}>
            {(control) => <Input {...control} name="name" maxLength={80} autoComplete="off" defaultValue={team.name} />}
          </Field>
          <Field label="Description (optional)" error={errors.description}>
            {(control) => (
              <Input {...control} name="description" autoComplete="off" defaultValue={team.description ?? ''} />
            )}
          </Field>
          <Field label="Department (optional)" error={errors.departmentId}>
            {(control) => (
              <Select {...control} name="departmentId" defaultValue={team.departmentId ?? ''}>
                <option value="">None</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Visibility" error={errors.visibility}>
            {(control) => (
              <Select {...control} name="visibility" defaultValue={team.visibility}>
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
