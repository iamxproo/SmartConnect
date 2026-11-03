import { Button } from '@smartconnect/ui/components/button';
import { Link, Outlet } from '@tanstack/react-router';
import { SearchX } from 'lucide-react';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { LoadingState } from '@/components/states/loading-state';
import { describeError } from '@/lib/api/messages';
import { useCurrentOrg, useMembership } from '@/lib/queries/orgs';

/** Resolves `/o/$orgSlugOrId` through the caller's organizations; renders children only for a real membership. */
export function OrgLayout() {
  const { org, orgs } = useCurrentOrg();
  const membership = useMembership(org?.id);

  if (orgs.isPending) return <LoadingState label="Loading organization" />;
  if (orgs.isError) return <ErrorState description={describeError(orgs.error)} onRetry={() => void orgs.refetch()} />;
  if (!org) {
    return (
      <EmptyState
        icon={SearchX}
        title="Organization not found"
        description="This organization doesn't exist, or you are not a member of it."
        action={
          <Button asChild variant="outline">
            <Link to="/">All organizations</Link>
          </Button>
        }
      />
    );
  }
  if (membership.isPending) return <LoadingState label="Loading organization" />;
  if (membership.isError) {
    return <ErrorState description={describeError(membership.error)} onRetry={() => void membership.refetch()} />;
  }
  return <Outlet />;
}
