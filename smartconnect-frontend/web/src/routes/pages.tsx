import { Button } from '@smartconnect/ui/components/button';
import { Link } from '@tanstack/react-router';
import { SearchX } from 'lucide-react';
import { EmptyState } from '@/components/states/empty-state';
import type { Section } from '@/components/shell/navigation';

/** Honest placeholder for a section that is not built yet: says what it will be and when. */
export function SectionPlaceholder({ section }: { section: Section }) {
  return (
    <EmptyState
      icon={section.icon}
      title="Not available yet"
      description={`${section.summary} arrive in ${section.phase}. Nothing on this page is functional yet.`}
    />
  );
}

export function NotFoundPage() {
  return (
    <EmptyState
      icon={SearchX}
      title="Page not found"
      description="This address doesn't match any page in SmartConnect."
      action={
        <Button asChild variant="outline">
          <Link to="/">Go to Home</Link>
        </Button>
      }
    />
  );
}
