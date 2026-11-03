import { Avatar, AvatarFallback } from '@smartconnect/ui/components/avatar';
import { Badge } from '@smartconnect/ui/components/badge';
import { Button } from '@smartconnect/ui/components/button';
import { Select } from '@smartconnect/ui/components/input';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { RevealItem } from '@/components/motion/reveal';
import { QueryState } from '@/components/states/query-state';
import { useToast } from '@/components/toast/toaster';
import { describeError } from '@/lib/api/messages';
import { useMembers } from '@/lib/queries/orgs';

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

interface Person {
  userId: string;
  role: string;
}

/** What the caller may do to a member list. UI hint only: the server decides and its refusals are shown. */
export interface Manage {
  canAdd: boolean;
  canRemove: boolean;
  /** Roles offered in the role picker; empty = roles cannot be changed from here. */
  roles: string[];
  defaultRole: string;
  onSet: (userId: string, role: string) => Promise<unknown>;
  onRemove: (userId: string) => Promise<unknown>;
}

/** Workspace and channel membership carries user ids only; names come from the organization's member list. */
export function PeopleList({ orgId, people, manage }: { orgId: string; people: Person[]; manage?: Manage }) {
  const directory = useMembers(orgId);
  const toast = useToast();
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  return (
    <QueryState query={directory} label="members">
      {(members) => {
        const nameOf = (userId: string) =>
          members.find((member) => member.userId === userId)?.displayName ?? 'Unknown member';
        return (
          <div className="flex flex-col gap-3">
            {people.length === 0 ? <p className="text-sm text-muted-foreground">No members.</p> : null}
            <ul className="grid gap-2 sm:grid-cols-2">
              {people.map((person, index) => {
                const name = nameOf(person.userId);
                return (
                  <RevealItem key={person.userId} index={index} className="flex items-center gap-2 text-sm">
                    <Avatar className="size-7">
                      <AvatarFallback>{initials(name) || '?'}</AvatarFallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {manage?.canRemove && manage.roles.length > 0 ? (
                      <Select
                        aria-label={`Role for ${name}`}
                        className="h-8 w-28"
                        value={person.role}
                        onChange={(event) =>
                          void manage.onSet(person.userId, event.target.value).catch((error: unknown) =>
                            toast({
                              title: "Couldn't change the role",
                              description: describeError(error),
                              tone: 'error',
                            }),
                          )
                        }
                      >
                        {manage.roles.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Badge>{person.role}</Badge>
                    )}
                    {manage?.canRemove ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${name}`}
                        onClick={() => setRemoving({ userId: person.userId, name })}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </RevealItem>
                );
              })}
            </ul>
            {manage?.canAdd ? (
              <AddPerson
                candidates={members.filter((member) => !people.some((person) => person.userId === member.userId))}
                manage={manage}
              />
            ) : null}
            <ConfirmDialog
              open={removing !== null}
              onOpenChange={(open) => !open && setRemoving(null)}
              title={`Remove ${removing?.name ?? ''}?`}
              description="They will lose access that comes from this membership."
              confirmLabel="Remove"
              onConfirm={async () => {
                if (!removing || !manage) return;
                await manage.onRemove(removing.userId);
                toast({ title: `${removing.name} was removed` });
              }}
            />
          </div>
        );
      }}
    </QueryState>
  );
}

function AddPerson({ candidates, manage }: { candidates: { userId: string; displayName: string }[]; manage: Manage }) {
  const toast = useToast();
  const { formProps, errors, formError, pending } = useForm({
    fields: ['userId', 'role'],
    validate: (values) => ({ userId: values.userId ? undefined : 'Choose a person.' }),
    submit: async (values) => {
      await manage.onSet(values.userId, values.role || manage.defaultRole);
      toast({ title: 'Member added' });
      formProps.ref.current?.reset();
    },
  });
  return (
    <form {...formProps} aria-label="Add a member" className="flex flex-col gap-2">
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
        {manage.roles.length > 0 ? (
          <Field label="Role">
            {(control) => (
              <Select {...control} name="role" defaultValue={manage.defaultRole}>
                {manage.roles.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : (
          <span />
        )}
        <Button type="submit" size="sm" disabled={pending} className="sm:mt-[1.625rem]">
          Add
        </Button>
      </div>
    </form>
  );
}
