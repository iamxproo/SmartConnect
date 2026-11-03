import { Button } from '@smartconnect/ui/components/button';
import { Link, Outlet, useRouter } from '@tanstack/react-router';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { PageTransition } from '@/components/motion/page-transition';
import { ErrorState } from '@/components/states/error-state';
import { isSuperAdmin } from '@/lib/admin';
import { useAuthState, useAuthStore } from '@/lib/auth';
import { APP_NAME, usePageTitle } from '@/lib/page-title';
import { useFocusOnNavigate } from '@/lib/route-focus';

/**
 * Platform administration layout (ADR 0015), apart from the organization app shell: a Super Admin is not a member of
 * any organization. Accounts without the role see a refusal and nothing below it is rendered, so no admin API is
 * even called for them; the APIs refuse them anyway.
 */
export function AdminLayout() {
  usePageTitle();
  const auth = useAuthState();
  const store = useAuthStore();
  const router = useRouter();
  const mainRef = useRef<HTMLElement>(null);
  const pathname = useFocusOnNavigate(mainRef);

  useEffect(() => {
    if (auth.status !== 'anonymous') return;
    const redirect = auth.expired ? router.state.location.href : undefined;
    void router.navigate({ to: '/admin/login', search: { redirect }, replace: true });
  }, [auth, router]);

  if (auth.status !== 'authenticated') return null;
  const allowed = isSuperAdmin(auth.user);
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="size-5" aria-hidden="true" />
          {APP_NAME} · Platform administration
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{auth.user.email}</span>
          <Button variant="outline" size="sm" onClick={() => void store.logout()}>
            Sign out
          </Button>
        </div>
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 p-4 outline-none md:p-6">
        {allowed ? (
          <PageTransition key={pathname}>
            <Outlet />
          </PageTransition>
        ) : (
          <>
            <h1 className="sr-only">Platform administration</h1>
            <ErrorState
              title="Not a platform administrator"
              description={`This area is for SmartConnect platform administrators. You are signed in as ${auth.user.email}.`}
            />
            <p className="text-center text-sm">
              <Link to="/" className="text-primary underline-offset-4 hover:underline">
                Back to SmartConnect
              </Link>
            </p>
          </>
        )}
      </main>
    </div>
  );
}
