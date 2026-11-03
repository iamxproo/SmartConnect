import { motion } from 'motion/react';
import type { ComponentProps } from 'react';
import { enterTransition } from '@/lib/motion';

const MAX_STAGGER_ITEMS = 8;

/** List item that fades and slides in on load, staggered by `index` (capped so long lists do not drag). */
export function RevealItem({
  index = 0,
  hoverLift = false,
  ...props
}: ComponentProps<typeof motion.li> & {
  index?: number;
  /** Cards: rise 1px with a shadow on hover. */
  hoverLift?: boolean;
}) {
  return (
    <motion.li
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...enterTransition, delay: Math.min(index, MAX_STAGGER_ITEMS) * 0.03 }}
      whileHover={hoverLift ? { y: -1 } : undefined}
      {...props}
    />
  );
}
