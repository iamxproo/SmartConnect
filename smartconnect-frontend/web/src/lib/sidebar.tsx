import { createContext, use, useCallback, useMemo, useState, type ReactNode } from 'react';

export const SIDEBAR_STORAGE_KEY = 'sc-sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

interface SidebarContextValue {
  /** Desktop: icon-only rail instead of the full sidebar. Persisted per browser. */
  collapsed: boolean;
  toggleCollapsed: () => void;
  /** Small screens: navigation shown in a modal sheet. */
  mobileOpen: boolean;
  setMobileOpen: (open: boolean) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {
        // Storage unavailable: the state still applies for this session.
      }
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ collapsed, toggleCollapsed, mobileOpen, setMobileOpen }),
    [collapsed, toggleCollapsed, mobileOpen],
  );
  return <SidebarContext value={value}>{children}</SidebarContext>;
}

export function useSidebar(): SidebarContextValue {
  const context = use(SidebarContext);
  if (!context) throw new Error('useSidebar must be used inside <SidebarProvider>');
  return context;
}
