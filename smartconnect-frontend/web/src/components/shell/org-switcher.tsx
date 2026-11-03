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
import { Link, useRouter } from '@tanstack/react-router';
import { Building2, ChevronsUpDown, Plus } from 'lucide-react';
import { useCurrentOrg } from '@/lib/queries/orgs';

/** Switches between the organizations the caller belongs to. Switching navigates; the server decides access. */
export function OrgSwitcher({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const router = useRouter();
  const { org, orgs } = useCurrentOrg();
  const name = org?.name ?? 'No organization selected';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn('h-11 w-full justify-start gap-2 px-2', collapsed && 'justify-center px-0')}
          // Collapsed, nothing is visible, so the label names it; expanded, the name comes from the visible text
          // (WCAG 2.5.3: the accessible name must contain what sighted voice-control users read).
          aria-label={collapsed ? `Organization: ${org?.name ?? 'none selected'}` : undefined}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-hover text-muted-foreground">
            <Building2 className="size-4" aria-hidden="true" />
          </span>
          {!collapsed ? (
            <>
              <span className="flex min-w-0 flex-col text-left">
                <span className="truncate text-sm font-medium">
                  <span className="sr-only">Organization:</span> {name}
                  <span className="sr-only">,</span>
                </span>
                <span className="truncate text-xs text-muted-foreground">{org ? org.role.name : 'Choose one'}</span>
              </span>
              <ChevronsUpDown className="ml-auto text-muted-foreground" aria-hidden="true" />
            </>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {orgs.isPending ? <DropdownMenuLabel className="font-normal">Loading…</DropdownMenuLabel> : null}
        {orgs.isError ? (
          <DropdownMenuLabel className="font-normal">Could not load organizations.</DropdownMenuLabel>
        ) : null}
        <DropdownMenuRadioGroup
          value={org?.id ?? ''}
          onValueChange={(id) => {
            const next = orgs.data?.find((candidate) => candidate.id === id);
            if (next) {
              onNavigate?.();
              void router.navigate({ to: '/o/$orgSlugOrId', params: { orgSlugOrId: next.slug } });
            }
          }}
        >
          {orgs.data?.map((candidate) => (
            <DropdownMenuRadioItem key={candidate.id} value={candidate.id}>
              {candidate.name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/" onClick={onNavigate}>
            <Building2 aria-hidden="true" />
            All organizations
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/organizations/new" onClick={onNavigate}>
            <Plus aria-hidden="true" />
            Create organization
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
