import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// tailwind-merge must know the design system's custom scale names; otherwise `text-md` would be
// mistaken for a colour and silently dropped when merged with `text-foreground`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['md'],
      ease: ['standard', 'enter', 'exit'],
    },
  },
});

/** Merges class names, letting later Tailwind utilities override earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
