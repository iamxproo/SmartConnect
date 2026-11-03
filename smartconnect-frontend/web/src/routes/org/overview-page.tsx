import { Badge } from '@smartconnect/ui/components/badge';
import { Link } from '@tanstack/react-router';
import { Boxes, MailPlus, Network, UserRound, UsersRound } from 'lucide-react';
import { Card, PageContainer, PageHeader } from '@/components/page';
import { RevealItem } from '@/components/motion/reveal';
import { QueryState } from '@/components/states/query-state';
import { useCan, useMembership, useOrganization, useRequiredOrg } from '@/lib/queries/orgs';

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
