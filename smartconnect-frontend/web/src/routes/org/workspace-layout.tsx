import { Button } from '@smartconnect/ui/components/button';
import { Link, Outlet, useParams } from '@tanstack/react-router';
import { SearchX } from 'lucide-react';
import { ApiError } from '@/lib/api/errors';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import { useRequiredOrg } from '@/lib/queries/orgs';
import { useWorkspace } from '@/lib/queries/workspaces';

/** Loads the workspace named in the URL; a missing and a not-visible workspace look the same (404). */
export function WorkspaceLayout() {
  const org = useRequiredOrg();
  const { workspaceId } = useParams({ from: '/app/o/$orgSlugOrId/w/$workspaceId' });
  const workspace = useWorkspace(org.id, workspaceId);

  if (workspace.error instanceof ApiError && workspace.error.status === 404) {
    return (
      <EmptyState
        icon={SearchX}
        title="Workspace not found"
        description="This workspace doesn't exist, or you don't have access to it."
        action={
          <Button asChild variant="outline">
            <Link to="/o/$orgSlugOrId/workspaces" params={{ orgSlugOrId: org.slug }}>
              All workspaces
            </Link>
          </Button>
        }
      />
    );
  }
  return (
    <QueryState query={workspace} label="the workspace">
      {() => <Outlet />}
    </QueryState>
  );
}
