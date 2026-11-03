import { Button } from '@smartconnect/ui/components/button';
import { useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { TriangleAlert } from 'lucide-react';

interface ErrorStateProps {
  title?: string;
  description?: string;
  /** Technical detail; only rendered in development builds. */
  details?: string;
  onRetry?: () => void;
}

/** Announced immediately to assistive technology (role="alert"); never shows stack traces in production. */
export function ErrorState({
  title = 'Something went wrong',
  description = 'This part of SmartConnect could not be displayed. Try again; if the problem continues, reload the page.',
  details,
  onRetry,
}: ErrorStateProps) {
  return (
    <div role="alert" className="mx-auto flex max-w-md flex-col items-center px-6 py-16 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-surface-hover text-danger">
        <TriangleAlert className="size-6" aria-hidden="true" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      {import.meta.env.DEV && details ? (
        <pre className="mt-4 max-w-full overflow-x-auto rounded-md bg-subtle p-3 text-left font-mono text-xs text-muted-foreground">
          {details}
        </pre>
      ) : null}
      {onRetry ? (
        <Button variant="outline" className="mt-6" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Router-level error boundary for a route: the shell stays usable and the route can be retried. */
export function RouteErrorState({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <ErrorState
      details={error instanceof Error ? error.message : String(error)}
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
    />
  );
}
