import { Outlet } from '@tanstack/react-router';
import { MessagesSquare } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { PageTransition } from '@/components/motion/page-transition';
import { APP_NAME, usePageTitle } from '@/lib/page-title';
import { useFocusOnNavigate } from '@/lib/route-focus';

/** Centered layout for pages that work while signed out (sign in, register, verification, invitations). */
export function AuthLayout() {
  usePageTitle();
  const mainRef = useRef<HTMLElement>(null);
  const pathname = useFocusOnNavigate(mainRef);
  return (
    <div className="flex min-h-dvh flex-col items-center bg-background px-4 py-10 text-foreground">
      <header className="mb-6 flex items-center gap-2 text-md font-semibold">
        <MessagesSquare className="size-5" aria-hidden="true" />
        {APP_NAME}
      </header>
      <main id="main" ref={mainRef} tabIndex={-1} className="w-full max-w-sm outline-none">
        <PageTransition key={pathname}>
          <Outlet />
        </PageTransition>
      </main>
    </div>
  );
}

export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
      <h1 className="text-xl font-semibold">{title}</h1>
      {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      <div className="mt-5 flex flex-col gap-4">{children}</div>
    </div>
  );
}
