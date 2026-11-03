import { cn } from '@smartconnect/ui/lib/utils';
import { Link, Outlet } from '@tanstack/react-router';
import { PageContainer, PageHeader } from '@/components/page';

const tabs = [
  { to: '/account/sessions', label: 'Sessions' },
  { to: '/account/password', label: 'Password' },
] as const;

/** Account pages sit outside any organization: they belong to the person, not the company. */
export function AccountLayout() {
  return (
    <PageContainer>
      <PageHeader title="Your account" description="Where you are signed in, and how you sign in." />
      <nav aria-label="Account" className="-mt-2 flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className={cn(
              '-mb-px rounded-t-md border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground',
              'hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            )}
            activeProps={{ 'aria-current': 'page', className: 'border-primary text-foreground' }}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </PageContainer>
  );
}
