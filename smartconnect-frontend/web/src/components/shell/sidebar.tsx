import { useParams } from '@tanstack/react-router';
import { Building2 } from 'lucide-react';
import { useCurrentOrg, usePermissions } from '@/lib/queries/orgs';
import { ChannelList } from './channel-list';
import { NavLink, NavList } from './nav-list';
import { placeholderNavigation, primaryNavigation } from './navigation';
import { OrgSwitcher } from './org-switcher';
import { WorkspaceSwitcher } from './workspace-switcher';

/** Sidebar body, shared by the desktop rail and the mobile sheet. */
export function SidebarContent({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { org } = useCurrentOrg();
  const workspaceId = useParams({ strict: false }).workspaceId;
  const allows = usePermissions(org?.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-1 border-b border-border p-2">
        <OrgSwitcher collapsed={collapsed} onNavigate={onNavigate} />
        {org ? (
          <WorkspaceSwitcher orgId={org.id} orgSlugOrId={org.slug} collapsed={collapsed} onNavigate={onNavigate} />
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <nav aria-label="Primary">
          {org ? (
            <NavList
              items={primaryNavigation(org.slug)}
              collapsed={collapsed}
              onNavigate={onNavigate}
              allows={allows}
            />
          ) : (
            <ul>
              <li>
                <NavLink
                  label="All organizations"
                  icon={Building2}
                  available
                  exact
                  collapsed={collapsed}
                  onNavigate={onNavigate}
                  link={{ to: '/' }}
                />
              </li>
            </ul>
          )}
        </nav>
        {org && workspaceId && !collapsed ? (
          <ChannelList orgId={org.id} orgSlugOrId={org.slug} workspaceId={workspaceId} onNavigate={onNavigate} />
        ) : null}
      </div>
      {org ? (
        <nav aria-label="Secondary" className="border-t border-border p-2">
          <NavList items={placeholderNavigation(org.slug)} collapsed={collapsed} onNavigate={onNavigate} />
        </nav>
      ) : null}
    </div>
  );
}
