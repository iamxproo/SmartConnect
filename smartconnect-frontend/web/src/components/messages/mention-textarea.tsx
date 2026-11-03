import { Textarea } from '@smartconnect/ui/components/input';
import { cn } from '@smartconnect/ui/lib/utils';
import { useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from 'react';
import type { Mentionable } from '@/lib/message-format';

const MAX_SUGGESTIONS = 6;
/** "@" at a word start, then what has been typed of the name (names may contain spaces). */
const TRIGGER = /(?:^|[\s(])@([^@<>\n]{0,40})$/u;

type TextareaProps = Omit<ComponentProps<typeof Textarea>, 'value' | 'onChange'>;

interface MentionTextareaProps extends TextareaProps {
  value: string;
  onValueChange: (value: string) => void;
  /** People who can be mentioned here. The text carries "@Name"; the sender converts it to `<@id>` tokens. */
  mentionables: readonly Mentionable[];
}

/**
 * A textarea with an "@" autocomplete. It follows the combobox keyboard pattern on a plain textbox: arrows move through
 * the suggestions, Enter or Tab accept, Escape closes. Enter and Tab keep their usual meaning while it is closed.
 */
export function MentionTextarea({
  value,
  onValueChange,
  mentionables,
  onKeyDown,
  className,
  ...rest
}: MentionTextareaProps) {
  const listId = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape closes the list for what has been typed so far; typing on reopens it.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const before = value.slice(0, caret);
  const match = TRIGGER.exec(before);
  const start = match ? before.length - match[1]!.length - 1 : -1;
  const query = match?.[1]?.toLowerCase() ?? '';
  const suggestions = useMemo(
    () =>
      match ? mentionables.filter((person) => person.name.toLowerCase().includes(query)).slice(0, MAX_SUGGESTIONS) : [],
    [match, mentionables, query],
  );
  const open = suggestions.length > 0 && dismissed !== `${start}:${query}`;
  const current = Math.min(active, Math.max(suggestions.length - 1, 0));

  useLayoutEffect(() => {
    if (pendingCaret.current !== null && area.current) {
      area.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  });

  function accept(person: Mentionable) {
    const inserted = `@${person.name} `;
    const next = value.slice(0, start) + inserted + value.slice(caret);
    pendingCaret.current = start + inserted.length;
    setCaret(start + inserted.length);
    setDismissed(null);
    onValueChange(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && !event.nativeEvent.isComposing) {
      const move = (delta: number) => {
        event.preventDefault();
        setActive((current + delta + suggestions.length) % suggestions.length);
      };
      if (event.key === 'ArrowDown') return move(1);
      if (event.key === 'ArrowUp') return move(-1);
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        return accept(suggestions[current]!);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        return setDismissed(`${start}:${query}`);
      }
    }
    onKeyDown?.(event);
  }

  return (
    <div className="relative flex-1">
      <Textarea
        {...rest}
        ref={area}
        value={value}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${current}` : undefined}
        onChange={(event) => {
          setCaret(event.target.selectionStart);
          setActive(0);
          onValueChange(event.target.value);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={handleKeyDown}
        className={cn('w-full', className)}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="People to mention"
          className="absolute bottom-full left-0 z-(--sc-z-dropdown) mb-1 max-h-56 w-64 max-w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
        >
          {suggestions.map((person, index) => (
            <li
              key={person.userId}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === current}
              // Keep focus in the textarea while picking.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => accept(person)}
              className={cn(
                'cursor-pointer truncate rounded-md px-2 py-1.5',
                index === current && 'bg-accent text-accent-foreground',
              )}
            >
              {person.name}
            </li>
          ))}
        </ul>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {open ? `${suggestions.length} ${suggestions.length === 1 ? 'person' : 'people'} to mention` : ''}
      </p>
    </div>
  );
}
