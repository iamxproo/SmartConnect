import { Skeleton } from '@smartconnect/ui/components/skeleton';
import { useEffect, useState } from 'react';

/** Delay before skeletons appear, so fast loads never flash (docs/architecture/design-system.md). */
export const SKELETON_DELAY_MS = 150;

/**
 * Announces loading to assistive technology immediately (role="status"); the visual skeleton appears only
 * if loading takes longer than SKELETON_DELAY_MS.
 */
export function LoadingState({ label = 'Loading' }: { label?: string }) {
  const [showSkeleton, setShowSkeleton] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowSkeleton(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div role="status" aria-busy="true" className="mx-auto w-full max-w-3xl p-6">
      <span className="sr-only">{label}…</span>
      {showSkeleton ? (
        <div data-testid="loading-skeleton" className="flex flex-col gap-4">
          <Skeleton className="h-6 w-1/3" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-1/4" />
                <Skeleton className="h-3 w-3/4" />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
