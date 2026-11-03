import type { ComponentProps } from 'react';
import { cn } from '../lib/utils.js';

const controlClasses = cn(
  'h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground',
  'transition-colors duration-(--sc-duration-fast) ease-standard',
  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
  'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger',
);

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" className={cn(controlClasses, className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(controlClasses, 'h-auto min-h-9 py-2', className)} {...props} />;
}

/** Native `<select>`: free keyboard and screen-reader behaviour, styled like Input. */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select data-slot="select" className={cn(controlClasses, 'pr-8', className)} {...props} />;
}
