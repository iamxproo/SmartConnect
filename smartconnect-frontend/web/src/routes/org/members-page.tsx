import { Avatar, AvatarFallback } from '@smartconnect/ui/components/avatar';
import { Badge } from '@smartconnect/ui/components/badge';
import { Button } from '@smartconnect/ui/components/button';
import { Select } from '@smartconnect/ui/components/input';
import { useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog';
import { RevealItem } from '@/components/motion/reveal';
import { PageContainer, PageHeader } from '@/components/page';
import { initials } from '@/components/people-list';
import { QueryState } from '@/components/states/query-state';
import { useToast } from '@/components/toast/toaster';
import { describeError } from '@/lib/api/messages';
import type { Member } from '@/lib/api/types';
import {
  useCan,
  useMembers,
  useMembership,
  useRemoveMember,
  useRequiredOrg,
  useRoles,
  useUpdateMember,
} from '@/lib/queries/orgs';

export function MembersPage() {
  const org = useRequiredOrg();
  const members = useMembers(org.id);
  const canManage = useCan(org.id, 'members.manage');
  const roles = useRoles(org.id);

  return (
    <PageContainer>
      <PageHeader title="Members" description="Everyone in this organization." />
      <QueryState query={members} label="members">
        {(list) => (
          <ul className="flex flex-col gap-2">
            {list.map((member, index) => (
              <RevealItem key={member.id} index={index}>
                <MemberRow member={member} canManage={canManage} roles={roles.data ?? []} />
              </RevealItem>
            ))}
          </ul>
        )}
      </QueryState>
    </PageContainer>
  );
}

function MemberRow({
  member,
  canManage,
  roles,
}: {
  member: Member;
  canManage: boolean;
  roles: { id: string; name: string }[];
}) {
  const org = useRequiredOrg();
  const router = useRouter();
  const toast = useToast();
  const self = useMembership(org.id).data?.memberId === member.id;
  const update = useUpdateMember(org.id);
  const remove = useRemoveMember(org.id);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
      <Avatar className="size-8">
        <AvatarFallback>{initials(member.displayName) || '?'}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {member.displayName}
          {self ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {member.email}
          {member.title ? ` · ${member.title}` : ''}
        </p>
      </div>
      {canManage && roles.length > 0 ? (
        <Select
          aria-label={`Role for ${member.displayName}`}
          className="w-36"
          value={member.role.id}
          disabled={update.isPending}
          onChange={(event) =>
            update.mutate(
              { memberId: member.id, roleId: event.target.value },
              {
                onSuccess: () => toast({ title: `Role updated for ${member.displayName}` }),
                onError: (error) =>
                  toast({ title: "Couldn't change the role", description: describeError(error), tone: 'error' }),
              },
            )
          }
        >
          {roles.map((role) => (
            <option key={role.id} value={role.id}>
              {role.name}
            </option>
          ))}
        </Select>
      ) : (
        <Badge>{member.role.name}</Badge>
      )}
      {self || canManage ? (
        <Button
          variant="outline"
          size="sm"
          aria-label={self ? 'Leave organization' : `Remove ${member.displayName}`}
          onClick={() => setConfirming(true)}
        >
          {self ? 'Leave' : 'Remove'}
        </Button>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={self ? `Leave ${org.name}?` : `Remove ${member.displayName}?`}
        description={
          self
            ? 'You will lose access to this organization and everything in it. Only a new invitation lets you return.'
            : 'They will lose access to the organization and everything in it.'
        }
        confirmLabel={self ? 'Leave organization' : 'Remove member'}
        onConfirm={async () => {
          await remove.mutateAsync(member.id);
          toast({ title: self ? `You left ${org.name}` : `${member.displayName} was removed` });
          if (self) void router.navigate({ to: '/' });
        }}
      />
    </div>
  );
}
