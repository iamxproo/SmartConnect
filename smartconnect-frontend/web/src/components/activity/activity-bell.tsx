import { Button } from '@smartconnect/ui/components/button';
import { Link } from '@tanstack/react-router';
import { Bell } from 'lucide-react';
import { ACTIVITY_COUNT_CAP, useActivityWatch, useUnreadActivityCount } from '@/lib/queries/activity';
import { useCurrentOrg } from '@/lib/queries/orgs';

export const countLabel = (count: number) => (count >= ACTIVITY_COUNT_CAP ? '99+' : String(count));

/** Top-bar entry to the activity page, with the number of unread items. Only inside an organization. */
export function ActivityBell() {
  const { org } = useCurrentOrg();
  const live = useActivityWatch(org?.id);
  const count = useUnreadActivityCount(org?.id, live).data ?? 0;
  if (!org) return null;
  const label = count === 0 ? 'Activity' : `Activity, ${count >= ACTIVITY_COUNT_CAP ? '99 or more' : count} unread`;
  return (
    <Button asChild variant="ghost" size="icon" className="relative">
      <Link to="/o/$orgSlugOrId/activity" params={{ orgSlugOrId: org.slug }} aria-label={label}>
        <Bell aria-hidden="true" />
        {count > 0 ? (
          <span
            aria-hidden="true"
            className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground"
          >
            {countLabel(count)}
          </span>
        ) : null}
      </Link>
    </Button>
  );
}
