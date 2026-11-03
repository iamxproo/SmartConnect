import { Button } from '@smartconnect/ui/components/button';
import { Link, Navigate } from '@tanstack/react-router';
import { Building2, ChevronRight, Plus } from 'lucide-react';
import { PageContainer, PageHeader } from '@/components/page';
import { RevealItem } from '@/components/motion/reveal';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import { useOrgs } from '@/lib/queries/orgs';

/** Lists the caller's organizations. With exactly one, goes straight into it. */
export function HomePage() {
  const orgs = useOrgs();
  return (
    <QueryState query={orgs} label="your organizations">
      {(list) => {
        if (list.length === 1 && list[0]) {
          return <Navigate to="/o/$orgSlugOrId" params={{ orgSlugOrId: list[0].slug }} replace />;
        }
        if (list.length === 0) {
          return (
            <EmptyState
              icon={Building2}
              title="You're not part of a company yet"
              description="Companies are created by authorized administrators, and people join by invitation. Open the invitation email you received to join one. If you expect to create a company, you can try below."
              action={
                <Button asChild variant="outline">
                  <Link to="/organizations/new">Create an organization</Link>
                </Button>
              }
            />
          );
        }
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
