import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describeError } from '@/lib/api/messages';
import { ErrorState } from './error-state';
import { LoadingState } from './loading-state';

/** Renders loading, failure (with retry) or the data of a query. */
export function QueryState<T>({
  query,
  label,
  children,
}: {
  query: UseQueryResult<T>;
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <LoadingState label={`Loading ${label}`} />;
  if (query.isError) {
    return (
      <ErrorState
        title={`Couldn't load ${label}`}
        description={describeError(query.error)}
        details={query.error.message}
        onRetry={() => void query.refetch()}
      />
    );
  }
  return <>{children(query.data)}</>;
}
