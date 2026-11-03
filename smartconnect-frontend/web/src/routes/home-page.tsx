import { Button } from '@smartconnect/ui/components/button';
import { Link, Navigate } from '@tanstack/react-router';
import { Building2, ChevronRight, MailCheck, Plus } from 'lucide-react';
import { ResendVerification } from '@/components/auth/resend-verification';
import { PageContainer, PageHeader } from '@/components/page';
import { RevealItem } from '@/components/motion/reveal';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import { useUser } from '@/lib/auth';
import { useCreationEligibility, useOrgs } from '@/lib/queries/orgs';

/**
 * Someone in no organization yet: start one (if this server lets them, ADR 0017), or join through an invitation.
 * When the server cannot say, the link is offered and the server decides.
 */
function NoOrganizationYet() {
  const user = useUser();
  const eligibility = useCreationEligibility();
  if (eligibility.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    );
  }
  const reason = eligibility.data?.reason;
  if (reason === 'email_not_verified') {
    return (
      <EmptyState
        icon={MailCheck}
        title="Verify your email to get started"
        description={`Open the link in the email we sent to ${user.email}. Then you can create your organization, or accept an invitation to join one.`}
        action={<ResendVerification />}
      />
    );
  }
  if (eligibility.data && !eligibility.data.allowed) {
    return (
      <EmptyState
        icon={Building2}
        title="You're not part of a company yet"
        description="People join a company by invitation. Open the invitation email you received to join one."
      />
    );
  }
  return (
    <EmptyState
      icon={Building2}
      title="Create your organization"
      description="Set up your company on SmartConnect. You'll be its owner, and you can invite your employees by email. Have an invitation instead? Open the link in the invitation email to join that company."
      action={
        <Button asChild>
          <Link to="/organizations/new">Create an organization</Link>
        </Button>
      }
    />
  );
}

/** Lists the caller's organizations. With exactly one, goes straight into it. */
export function HomePage() {
  const orgs = useOrgs();
  return (
    <QueryState query={orgs} label="your organizations">
      {(list) => {
        if (list.length === 1 && list[0]) {
          return <Navigate to="/o/$orgSlugOrId" params={{ orgSlugOrId: list[0].slug }} replace />;
        }
        if (list.length === 0) return <NoOrganizationYet />;
        return (
          <PageContainer>
            <PageHeader
              title="Your organizations"
              description="Choose a company to continue."
              actions={
                <Button asChild variant="outline" size="sm">
                  <Link to="/organizations/new">
                    <Plus aria-hidden="true" />
                    Create
                  </Link>
                </Button>
              }
            />
            <ul className="flex flex-col gap-2">
              {list.map((org, index) => (
                <RevealItem key={org.id} index={index} hoverLift>
                  <Link
                    to="/o/$orgSlugOrId"
                    params={{ orgSlugOrId: org.slug }}
                    className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition-shadow duration-(--sc-duration-base) ease-standard hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <span className="flex size-9 items-center justify-center rounded-md bg-surface-hover text-muted-foreground">
                      <Building2 className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{org.name}</span>
                      <span className="block text-sm text-muted-foreground">{org.role.name}</span>
                    </span>
                    <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
                  </Link>
                </RevealItem>
              ))}
            </ul>
          </PageContainer>
        );
      }}
    </QueryState>
  );
}
