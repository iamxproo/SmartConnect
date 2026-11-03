import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

export function Badge({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="badge"
      className={cn(
        'inline-flex items-center rounded-sm border border-border px-1.5 text-xs leading-5 whitespace-nowrap text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
