import { Button } from '@smartconnect/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@smartconnect/ui/components/dialog';
import { Input } from '@smartconnect/ui/components/input';
import { useNavigate } from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { describeError } from '@/lib/api/messages';
import type { Conversation, Member } from '@/lib/api/types';
import { useUser } from '@/lib/auth';
import { useCreateGroup, useStartDirect } from '@/lib/queries/conversations';
import { useRequiredOrg } from '@/lib/queries/orgs';
import { MemberPicker } from './member-picker';

export const MIN_GROUP_OTHERS = 2;
export const MAX_GROUP_OTHERS = 49;
const MAX_TITLE = 120;

function useOpenConversation() {
  const org = useRequiredOrg();
  const navigate = useNavigate();
  return (conversation: Conversation) =>
    navigate({
      to: '/o/$orgSlugOrId/messages/$conversationId',
      params: { orgSlugOrId: org.slug, conversationId: conversation.id },
    });
}

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Choosing a person starts (or reopens) the one direct conversation with them; 200 and 201 both open it. */
export function NewDirectDialog({ open, onOpenChange }: DialogProps) {
  const org = useRequiredOrg();
  const user = useUser();
  const start = useStartDirect(org.id);
  const openConversation = useOpenConversation();
  const [error, setError] = useState<string | null>(null);

  async function pick(member: Member) {
    if (start.isPending) return;
    setError(null);
    try {
      const conversation = await start.mutateAsync(member.userId);
      onOpenChange(false);
      await openConversation(conversation);
    } catch (failure) {
      setError(describeError(failure));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent aria-describedby="new-direct-hint">
        <DialogTitle>New message</DialogTitle>
        <DialogDescription id="new-direct-hint">Choose a person to message.</DialogDescription>
        <div className="mt-4 flex flex-col gap-3">
          <FormError message={error} />
          <MemberPicker
            orgId={org.id}
            label="Find a person"
            exclude={[user.id]}
            onPick={(member) => void pick(member)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 2 to 49 other members and an optional title. */
export function NewGroupDialog({ open, onOpenChange }: DialogProps) {
  const org = useRequiredOrg();
  const user = useUser();
  const create = useCreateGroup(org.id);
  const openConversation = useOpenConversation();
  const [chosen, setChosen] = useState<Member[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const ready = chosen.length >= MIN_GROUP_OTHERS && chosen.length <= MAX_GROUP_OTHERS;

  function toggle(member: Member) {
    setChosen((list) =>
      list.some((m) => m.userId === member.userId)
        ? list.filter((m) => m.userId !== member.userId)
        : list.length < MAX_GROUP_OTHERS
          ? [...list, member]
          : list,
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || create.isPending) return;
    setError(null);
    try {
      const conversation = await create.mutateAsync({
        title: title.trim() || undefined,
        userIds: chosen.map((m) => m.userId),
      });
      onOpenChange(false);
      setChosen([]);
      setTitle('');
      await openConversation(conversation);
    } catch (failure) {
      setError(describeError(failure));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="new-group-hint">
        <DialogTitle>New group</DialogTitle>
        <DialogDescription id="new-group-hint">
          Choose {MIN_GROUP_OTHERS} to {MAX_GROUP_OTHERS} other people. You become the group's administrator.
        </DialogDescription>
        <form onSubmit={(event) => void submit(event)} className="mt-4 flex flex-col gap-4">
          <FormError message={error} />
          <Field label="Group name (optional)">
            {(control) => (
              <Input {...control} value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} />
            )}
          </Field>
          <MemberPicker
            orgId={org.id}
            label="Add people"
            exclude={[user.id]}
            selected={chosen.map((m) => m.userId)}
            onPick={toggle}
          />
          <ul aria-label="Chosen people" className="flex flex-wrap gap-1.5">
            {chosen.map((member) => (
              <li
                key={member.userId}
                className="flex items-center gap-1 rounded-sm border border-border py-0.5 pr-0.5 pl-2 text-sm"
              >
                {member.displayName}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  aria-label={`Remove ${member.displayName}`}
                  onClick={() => toggle(member)}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground" role="status">
            {chosen.length} of {MIN_GROUP_OTHERS}–{MAX_GROUP_OTHERS} chosen.
          </p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={!ready || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create group'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
