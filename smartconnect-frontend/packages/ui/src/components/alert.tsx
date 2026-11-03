import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

const alertVariants = cva('rounded-md border border-l-4 bg-subtle px-3 py-2 text-sm', {
  variants: {
    tone: {
      info: 'border-border border-l-info',
      success: 'border-border border-l-success',
      warning: 'border-border border-l-warning',
      danger: 'border-border border-l-danger',
    },
  },
  defaultVariants: { tone: 'info' },
});

/** Inline message. Add role="alert" for errors that appear after an action, role="status" for confirmations. */
export function Alert({ className, tone, ...props }: ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" className={cn(alertVariants({ tone }), className)} {...props} />;
}
