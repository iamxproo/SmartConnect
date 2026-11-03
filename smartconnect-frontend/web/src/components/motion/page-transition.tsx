import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { enterTransition } from '@/lib/motion';

/** Subtle fade + 6px rise when a page mounts. Keyed by the caller, so each navigation replays it. */
export function PageTransition({ children }: { children: ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={enterTransition}>
      {children}
    </motion.div>
  );
}
