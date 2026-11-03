import { Button } from '@smartconnect/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@smartconnect/ui/components/dropdown-menu';
import { cn } from '@smartconnect/ui/lib/utils';
import { Link, useParams, useRouter } from '@tanstack/react-router';
import { Boxes, ChevronsUpDown } from 'lucide-react';
import { useWorkspaces } from '@/lib/queries/workspaces';

/** Switches workspace within the current organization. Open workspaces the caller has not joined are listed too. */
export function WorkspaceSwitcher({
  orgId,
  orgSlugOrId,
  collapsed,
  onNavigate,
}: {
  orgId: string;
  orgSlugOrId: string;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const workspaceId = useParams({ strict: false }).workspaceId;
  const workspaces = useWorkspaces(orgId);
  const current = workspaces.data?.find((workspace) => workspace.id === workspaceId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn('h-9 w-full justify-start gap-2 px-2 text-sm', collapsed && 'justify-center px-0')}
          aria-label={collapsed ? `Workspace: ${current?.name ?? 'none selected'}` : undefined}
        >
          <Boxes className="size-4 text-muted-foreground" aria-hidden="true" />
          {!collapsed ? (
            <>
              <span className="truncate">
                <span className="sr-only">Workspace:</span> {current?.name ?? 'Choose a workspace'}
              </span>
              <ChevronsUpDown className="ml-auto text-muted-foreground" aria-hidden="true" />
            </>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {workspaces.isPending ? <DropdownMenuLabel className="font-normal">Loading…</DropdownMenuLabel> : null}
        {workspaces.isError ? (
          <DropdownMenuLabel className="font-normal">Could not load workspaces.</DropdownMenuLabel>
        ) : null}
        {workspaces.data?.length === 0 ? (
          <DropdownMenuLabel className="font-normal">No workspaces you can access yet.</DropdownMenuLabel>
        ) : null}
        <DropdownMenuRadioGroup
          value={workspaceId ?? ''}
          onValueChange={(id) => {
            onNavigate?.();
            void router.navigate({ to: '/o/$orgSlugOrId/w/$workspaceId', params: { orgSlugOrId, workspaceId: id } });
          }}
        >
          {workspaces.data?.map((workspace) => (
            <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>
              <span className="truncate">{workspace.name}</span>
              {workspace.myRole === null ? (
                <span className="ml-auto text-xs text-muted-foreground">Not joined</span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/o/$orgSlugOrId/workspaces" params={{ orgSlugOrId }} onClick={onNavigate}>
            <Boxes aria-hidden="true" />
            All workspaces
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
