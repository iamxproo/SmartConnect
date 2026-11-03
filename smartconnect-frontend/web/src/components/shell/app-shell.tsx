import { Sheet, SheetContent, SheetTitle } from '@smartconnect/ui/components/sheet';
import { TooltipProvider } from '@smartconnect/ui/components/tooltip';
import { cn } from '@smartconnect/ui/lib/utils';
import { Outlet, useRouter } from '@tanstack/react-router';
import { motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import { PageTransition } from '@/components/motion/page-transition';
import { useAuthState } from '@/lib/auth';
import { enterTransition } from '@/lib/motion';
import { usePageTitle } from '@/lib/page-title';
import { useFocusOnNavigate } from '@/lib/route-focus';
import { SidebarProvider, useSidebar } from '@/lib/sidebar';
import { SidebarContent } from './sidebar';
import { DESKTOP_SIDEBAR_ID, TopBar } from './top-bar';
import { VerificationBanner } from './verification-banner';

/** Authenticated layout. If the session ends while it is open, the person is sent back to sign in. */
export function AppShell() {
  const auth = useAuthState();
  const router = useRouter();

  useEffect(() => {
    if (auth.status !== 'anonymous') return;
    // An expired session returns to where the person was; an explicit sign-out does not.
    const redirect = auth.expired ? router.state.location.href : undefined;
    void router.navigate({ to: '/login', search: { redirect }, replace: true });
  }, [auth, router]);

  if (auth.status !== 'authenticated') return null;
  return (
    <SidebarProvider>
      <TooltipProvider>
        <ShellLayout />
      </TooltipProvider>
    </SidebarProvider>
  );
}

function ShellLayout() {
  const { collapsed, mobileOpen, setMobileOpen } = useSidebar();
  const title = usePageTitle();
  const mainRef = useRef<HTMLElement>(null);
  const pathname = useFocusOnNavigate(mainRef);

  // The Sheet root (context only, no DOM) wraps the whole layout so the top bar's menu button is a real
  // SheetTrigger: Radix then returns focus to it when the sheet closes and manages aria-expanded.
  return (
    <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
      <div className="flex h-dvh overflow-hidden bg-background text-foreground">
        <a
          href="#main"
          className="sr-only rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-(--sc-z-toast)"
        >
          Skip to main content
        </a>

        <motion.aside
          id={DESKTOP_SIDEBAR_ID}
          aria-label="Sidebar"
          data-collapsed={collapsed}
          initial={false}
          animate={{ width: collapsed ? 64 : 240 }}
          transition={enterTransition}
          className={cn('hidden shrink-0 overflow-hidden border-r border-border bg-subtle md:flex md:flex-col')}
        >
          <SidebarContent collapsed={collapsed} />
        </motion.aside>

        <SheetContent aria-describedby={undefined} closeLabel="Close navigation" className="bg-subtle">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContent collapsed={false} onNavigate={() => setMobileOpen(false)} />
        </SheetContent>

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar title={title} />
          <VerificationBanner />
          <main id="main" ref={mainRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
            <PageTransition key={pathname}>
              <Outlet />
            </PageTransition>
          </main>
        </div>
      </div>
    </Sheet>
  );
}
