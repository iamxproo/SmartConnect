import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

/** Decorative placeholder block. Wrap groups of skeletons in an element with role="status" and a label. */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-surface-hover motion-reduce:animate-none', className)}
      {...props}
    />
  );
}
