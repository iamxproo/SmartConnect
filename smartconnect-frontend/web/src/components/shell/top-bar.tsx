import { Button } from '@smartconnect/ui/components/button';
import { SheetTrigger } from '@smartconnect/ui/components/sheet';
import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { ActivityBell } from '@/components/activity/activity-bell';
import { SearchButton } from '@/components/search/search-button';
import { useSidebar } from '@/lib/sidebar';
import { ThemeMenu } from './theme-menu';
import { UserMenu } from './user-menu';

export const DESKTOP_SIDEBAR_ID = 'app-sidebar';

export function TopBar({ title }: { title: string }) {
  const { collapsed, toggleCollapsed } = useSidebar();
  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
          <Menu aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <Button
        variant="ghost"
        size="icon"
        className="hidden md:inline-flex"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
        aria-controls={DESKTOP_SIDEBAR_ID}
        onClick={toggleCollapsed}
      >
        <CollapseIcon aria-hidden="true" />
      </Button>
      <h1 className="truncate text-md font-semibold">{title}</h1>
      <div className="ml-auto flex items-center gap-1">
        <SearchButton />
        <ActivityBell />
        <ThemeMenu />
        <UserMenu />
      </div>
    </header>
  );
}
