import { Avatar, AvatarFallback } from '@smartconnect/ui/components/avatar';
import { Badge } from '@smartconnect/ui/components/badge';
import { Button } from '@smartconnect/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@smartconnect/ui/components/dialog';
import { Input } from '@smartconnect/ui/components/input';
import { useNavigate } from '@tanstack/react-router';
import { UserPlus, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { initials } from '@/components/people-list';
import { useToast } from '@/components/toast/toaster';
import { describeError } from '@/lib/api/messages';
import type { Conversation, Member } from '@/lib/api/types';
import { useUser } from '@/lib/auth';
import { enterTransition } from '@/lib/motion';
import { useRemoveParticipant, useRenameGroup, useSetParticipant } from '@/lib/queries/conversations';
import { useRequiredOrg } from '@/lib/queries/orgs';
import { MemberPicker } from './member-picker';

export const GROUP_PANEL_ID = 'group-details';

interface GroupPanelProps {
  conversation: Conversation;
  nameOf: (userId: string) => string;
  onClose: () => void;
}

/** Participants and roles; administrators also rename, add, remove and change roles. Anyone may leave. */
export function GroupPanel({ conversation, nameOf, onClose }: GroupPanelProps) {
  const org = useRequiredOrg();
  const user = useUser();
  const toast = useToast();
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const isAdmin = conversation.myRole === 'admin';
  const set = useSetParticipant(org.id, conversation.id);
  const remove = useRemoveParticipant(org.id, conversation.id);
  const [removing, setRemoving] = useState<{ userId: string; name: string } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [adding, setAdding] = useState(false);

  // Move focus into the panel when it opens; the opener takes it back when it closes.
  useEffect(() => heading.current?.focus(), []);

  async function changeRole(userId: string, role: 'admin' | 'member') {
    try {
      await set.mutateAsync({ userId, role });
    } catch (error) {
      toast({ title: "Couldn't change the role", description: describeError(error), tone: 'error' });
    }
  }

  return (
    <motion.aside
      id={GROUP_PANEL_ID}
      aria-labelledby="group-details-heading"
      initial={{ x: 32, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 32, opacity: 0 }}
      transition={enterTransition}
      onKeyDown={(event) => {
        // Dialogs opened from here are portaled but still bubble their events through the panel.
        if (event.key === 'Escape' && event.currentTarget.contains(event.target as Node)) onClose();
      }}
      className="absolute inset-y-0 right-0 z-10 flex w-80 max-w-full flex-col gap-4 overflow-y-auto border-l border-border bg-background p-4 shadow-lg"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="group-details-heading" ref={heading} tabIndex={-1} className="text-md font-semibold outline-none">
          Group details
        </h3>
        <Button size="icon" variant="ghost" aria-label="Close group details" onClick={onClose}>
          <X aria-hidden="true" />
        </Button>
      </div>

      {isAdmin ? (
        <RenameForm key={conversation.title ?? ''} conversation={conversation} />
      ) : conversation.title ? (
        <p className="text-sm font-medium">{conversation.title}</p>
      ) : null}

      <section aria-labelledby="group-participants-heading" className="flex flex-col gap-2">
        <h4 id="group-participants-heading" className="text-sm font-medium">
          Participants ({conversation.participants.length})
        </h4>
        <ul className="flex flex-col gap-2">
          {conversation.participants.map((participant) => {
            const name = nameOf(participant.userId);
            const self = participant.userId === user.id;
            const other = participant.role === 'admin' ? 'member' : 'admin';
            return (
              <li key={participant.userId} className="flex flex-wrap items-center gap-2 text-sm">
                <Avatar className="size-7">
                  <AvatarFallback>{initials(name) || '?'}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate">
                  {name}
                  {self ? <span className="text-muted-foreground"> (you)</span> : null}
                </span>
                <Badge>{participant.role}</Badge>
                {isAdmin ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={other === 'admin' ? `Make admin: ${name}` : `Demote ${name} to member`}
                      onClick={() => void changeRole(participant.userId, other)}
                    >
                      {other === 'admin' ? 'Make admin' : 'Demote'}
                    </Button>
                    {self ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${name}`}
                        onClick={() => setRemoving({ userId: participant.userId, name })}
                      >
                        Remove
                      </Button>
                    )}
                  </>
                ) : null}
              </li>
            );
          })}
        </ul>
        {isAdmin ? (
          <Button size="sm" variant="outline" className="self-start" onClick={() => setAdding(true)}>
            <UserPlus aria-hidden="true" />
            Add people
          </Button>
        ) : null}
      </section>

      <Button variant="outline" className="mt-auto self-start" onClick={() => setLeaving(true)}>
        Leave group
      </Button>

      <AddPeopleDialog
        open={adding}
        onOpenChange={setAdding}
        exclude={conversation.participants.map((p) => p.userId)}
        onAdd={async (member) => {
          await set.mutateAsync({ userId: member.userId });
          toast({ title: `${member.displayName} was added` });
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? ''}?`}
        description="They lose access to this group, including messages they already saw."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (!removing) return;
          await remove.mutateAsync(removing.userId);
          toast({ title: `${removing.name} was removed` });
        }}
      />
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title="Leave this group?"
        description="You will stop receiving its messages and it disappears from your list. Someone has to add you back to rejoin."
        confirmLabel="Leave group"
        onConfirm={async () => {
          await remove.mutateAsync(user.id);
          toast({ title: 'You left the group' });
          await navigate({ to: '/o/$orgSlugOrId/messages', params: { orgSlugOrId: org.slug } });
        }}
      />
    </motion.aside>
  );
}

function RenameForm({ conversation }: { conversation: Conversation }) {
  const org = useRequiredOrg();
  const toast = useToast();
  const rename = useRenameGroup(org.id, conversation.id);
  const { formProps, formError, pending } = useForm({
    fields: ['title'],
    submit: async ({ title }) => {
      await rename.mutateAsync(title.trim() || null);
      toast({ title: 'Group renamed' });
    },
  });
  return (
    <form {...formProps} aria-label="Rename group" className="flex flex-col gap-2">
      <FormError message={formError} />
      <Field label="Group name" hint="Leave empty to show the participants' names.">
        {(control) => <Input {...control} name="title" maxLength={120} defaultValue={conversation.title ?? ''} />}
      </Field>
      <Button type="submit" size="sm" className="self-start" disabled={pending}>
        Save name
      </Button>
    </form>
  );
}

function AddPeopleDialog({
  open,
  onOpenChange,
  exclude,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exclude: string[];
  onAdd: (member: Member) => Promise<unknown>;
}) {
  const org = useRequiredOrg();
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent aria-describedby="add-people-hint">
        <DialogTitle>Add people</DialogTitle>
        <DialogDescription id="add-people-hint">They only see messages sent after they are added.</DialogDescription>
        <div className="mt-4 flex flex-col gap-3">
          <FormError message={error} />
          <MemberPicker
            orgId={org.id}
            label="Find a person to add"
            exclude={exclude}
            onPick={(member) => {
              setError(null);
              onAdd(member).then(
                () => onOpenChange(false),
                (failure: unknown) => setError(describeError(failure)),
              );
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
