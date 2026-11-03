import type { LucideIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}

/** A labelled region explaining why there is nothing to show, with an optional next step. */
export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center animate-sc-fade-in"
    >
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-surface-hover text-muted-foreground">
        <Icon className="size-6" aria-hidden="true" />
      </div>
      <h2 id={headingId} className="text-lg font-semibold">
        {title}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </section>
  );
}
