import { Button } from '@smartconnect/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@smartconnect/ui/components/dropdown-menu';
import { cn } from '@smartconnect/ui/lib/utils';
import { SmilePlus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { Reaction } from '@/lib/api/types';
import { enterTransition } from '@/lib/motion';

/** A small curated set: enough for acknowledging, agreeing and celebrating without a full emoji catalogue. */
export const CURATED_EMOJI = [
  { emoji: '👍', name: 'thumbs up' },
  { emoji: '❤️', name: 'heart' },
  { emoji: '😂', name: 'laughing' },
  { emoji: '🎉', name: 'celebration' },
  { emoji: '😮', name: 'surprised' },
  { emoji: '😢', name: 'sad' },
  { emoji: '🙏', name: 'thanks' },
  { emoji: '👀', name: 'eyes' },
  { emoji: '🚀', name: 'rocket' },
  { emoji: '✅', name: 'done' },
] as const;

interface PickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (emoji: string) => void;
}

/** The emoji picker: a menu of the curated set, so arrows, Enter and Escape work as they do in any menu. */
export function EmojiPicker({ open, onOpenChange, onPick }: PickerProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Add reaction">
          <SmilePlus aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="grid min-w-0 grid-cols-5 gap-0.5">
        {CURATED_EMOJI.map(({ emoji, name }) => (
          <DropdownMenuItem
            key={emoji}
            aria-label={`React with ${name}`}
            onSelect={() => onPick(emoji)}
            className="justify-center px-2 py-1.5 text-lg"
          >
            <span aria-hidden="true">{emoji}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Reaction counts as toggles: pressed means "you reacted"; pressing again takes it back. */
export function ReactionBar({
  reactions,
  canReact,
  onToggle,
}: {
  reactions: Reaction[];
  /** May add reactions; taking back one's own is always possible. */
  canReact: boolean;
  onToggle: (emoji: string, on: boolean) => void;
}) {
  if (reactions.length === 0) return null;
  return (
    <ul aria-label="Reactions" className="flex flex-wrap gap-1">
      <AnimatePresence initial={false}>
        {reactions.map(({ emoji, count, reacted }) => (
          <motion.li
            key={emoji}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={enterTransition}
          >
            <button
              type="button"
              aria-pressed={reacted}
              aria-label={`${emoji} ${count} ${count === 1 ? 'reaction' : 'reactions'}${reacted ? ', including yours' : ''}`}
              disabled={!canReact && !reacted}
              onClick={() => onToggle(emoji, !reacted)}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors duration-(--sc-duration-fast)',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-60',
                reacted
                  ? 'border-primary bg-accent text-accent-foreground'
                  : 'border-border bg-card text-muted-foreground hover:bg-surface-hover',
              )}
            >
              <span aria-hidden="true">{emoji}</span>
              <span aria-hidden="true">{count}</span>
            </button>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}
