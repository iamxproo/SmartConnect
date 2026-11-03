import { Badge } from '@smartconnect/ui/components/badge';
import { Button } from '@smartconnect/ui/components/button';
import { Link } from '@tanstack/react-router';
import { Boxes, CircleCheck, MailPlus, Network, UserRound, UsersRound } from 'lucide-react';
import { Card, PageContainer, PageHeader } from '@/components/page';
import { RevealItem } from '@/components/motion/reveal';
import { QueryState } from '@/components/states/query-state';
import { useCan, useHasOtherMembers, useMembership, useOrganization, useRequiredOrg } from '@/lib/queries/orgs';
import { useWorkspaces } from '@/lib/queries/workspaces';

/**
 * A new organization's first steps, for whoever can take them: invite the team, open a workspace (direct messages and
 * groups work without one; channels need one). Shown until both are done; a step whose state is unknown is offered.
 */
function GetStarted() {
  const org = useRequiredOrg();
  const canInvite = useCan(org.id, 'members.invite');
  const canCreateWorkspace = useCan(org.id, 'workspaces.create');
  const othersJoined = useHasOtherMembers(org.id, canInvite);
  const workspaces = useWorkspaces(canCreateWorkspace ? org.id : undefined);
  const params = { orgSlugOrId: org.slug };
  const steps = [
    ...(canInvite
      ? [
          {
            label: 'Invite your team',
            text: 'Send invitations by email. Each person joins with the address you invite.',
            to: '/o/$orgSlugOrId/invitations',
            action: 'Invite people',
            done: othersJoined.data === true,
          } as const,
        ]
      : []),
    ...(canCreateWorkspace
      ? [
          {
            label: 'Create a workspace',
            text: 'Channels live in workspaces. Direct messages and groups work right away.',
            to: '/o/$orgSlugOrId/workspaces',
            action: 'Open workspaces',
            done: (workspaces.data?.length ?? 0) > 0,
          } as const,
        ]
      : []),
  ];
  const loading = (canInvite && othersJoined.isPending) || (canCreateWorkspace && workspaces.isPending);
  if (steps.length === 0 || loading || steps.every((step) => step.done)) return null;
  return (
    <section aria-labelledby="get-started-heading" className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h3 id="get-started-heading" className="font-medium">
        Get started
      </h3>
      <ol className="flex flex-col gap-3">
        {steps.map((step) => (
          <li key={step.label} className="flex flex-wrap items-center gap-3">
            {step.done ? (
              <CircleCheck className="size-5 text-success" aria-label="Done" />
            ) : (
              <span className="size-5 rounded-full border border-border" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{step.label}</span>
              <span className="block text-sm text-muted-foreground">{step.text}</span>
            </span>
            {step.done ? null : (
              <Button asChild size="sm" variant="outline">
                <Link to={step.to} params={params}>
                  {step.action}
                </Link>
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function OverviewPage() {
  const org = useRequiredOrg();
  const details = useOrganization(org.id);
  const membership = useMembership(org.id).data;
  const canInvite = useCan(org.id, 'members.invite');
  const params = { orgSlugOrId: org.slug };
  const areas = [
    { to: '/o/$orgSlugOrId/workspaces', icon: Boxes, label: 'Workspaces', text: 'Where teams work and talk.' },
    { to: '/o/$orgSlugOrId/members', icon: UserRound, label: 'Members', text: 'Everyone in the company.' },
    { to: '/o/$orgSlugOrId/departments', icon: Network, label: 'Departments', text: 'How the company is organized.' },
    { to: '/o/$orgSlugOrId/teams', icon: UsersRound, label: 'Teams', text: 'Groups of people who work together.' },
    ...(canInvite
      ? [
          {
            to: '/o/$orgSlugOrId/invitations',
            icon: MailPlus,
            label: 'Invitations',
            text: 'Invite people by email.',
          } as const,
        ]
      : []),
  ] as const;

  return (
    <PageContainer>
      <QueryState query={details} label="the organization">
        {(organization) => (
          <PageHeader
            title={organization.name}
            description={organization.description ?? undefined}
            actions={<Badge>{membership?.role.name ?? org.role.name}</Badge>}
          />
        )}
      </QueryState>
      {membership?.title ? <p className="text-sm text-muted-foreground">Your title: {membership.title}</p> : null}
      <GetStarted />
      <ul className="grid gap-3 sm:grid-cols-2">
        {areas.map((area, index) => (
          <RevealItem key={area.to} index={index} hoverLift>
            <Link
              to={area.to}
              params={params}
              className="block rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Card className="h-full">
                <area.icon className="mb-2 size-5 text-muted-foreground" aria-hidden="true" />
                <p className="font-medium">{area.label}</p>
                <p className="text-sm text-muted-foreground">{area.text}</p>
              </Card>
            </Link>
          </RevealItem>
        ))}
      </ul>
    </PageContainer>
  );
}
