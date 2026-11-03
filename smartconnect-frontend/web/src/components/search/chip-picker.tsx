import { Button } from '@smartconnect/ui/components/button';
import { Input } from '@smartconnect/ui/components/input';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { describeError } from '@/lib/api/messages';
import type { Member, Page } from '@/lib/api/types';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useApi } from '@/lib/services';
import type { Chip } from './search-query';

const PICKER_LIMIT = 8;
const DEBOUNCE_MS = 200;

interface Props {
  kind: 'from' | 'in';
  orgId: string;
  onPick: (chip: Chip) => void;
  onClose: () => void;
}

interface Choice {
  id: string;
  label: string;
  detail?: string;
  chip: Chip;
}

/** Finds a person or channel through the existing searches and turns the choice into a filter chip. */
export function ChipPicker({ kind, orgId, onPick, onClose }: Props) {
  const api = useApi();
  const listId = useId();
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), DEBOUNCE_MS);
  const noun = kind === 'from' ? 'person' : 'channel';
  const found = useQuery({
    queryKey: ['orgs', orgId, 'search-picker', kind, q],
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }): Promise<Choice[]> => {
      if (kind === 'from') {
        const page = await api.get<Page<Member>>(
          `/orgs/${orgId}/members`,
          { q: q || undefined, limit: PICKER_LIMIT },
          signal,
        );
        return page.data.map((member) => ({
          id: member.userId,
          label: member.displayName,
          detail: member.email,
          chip: { kind: 'from', userId: member.userId, label: member.displayName },
        }));
      }
      const page = await api.get<Page<{ id: string; name: string; workspaceName: string }>>(
        `/orgs/${orgId}/channels`,
        { q: q || undefined, limit: PICKER_LIMIT },
        signal,
      );
      return page.data.map((channel) => ({
        id: channel.id,
        label: `#${channel.name}`,
        detail: channel.workspaceName,
        chip: { kind: 'in', channelId: channel.id, label: channel.name },
      }));
    },
  });

  return (
    <div
      role="group"
      aria-label={`Filter by ${noun}`}
      className="flex flex-col gap-2 rounded-md border border-border p-2"
    >
      <div className="flex items-center gap-2">
        <Input
          type="search"
          autoFocus
          aria-label={`Find a ${noun}`}
          aria-controls={listId}
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          placeholder={`Find a ${noun}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onClose();
            }
          }}
        />
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <div id={listId} aria-live="polite">
        {found.isError ? (
          <p role="alert" className="text-sm text-danger">
            Couldn’t look up {noun}s. {describeError(found.error)}
          </p>
        ) : found.isPending ? (
          <p className="text-sm text-muted-foreground">Searching…</p>
        ) : found.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No {noun} found.</p>
        ) : (
          <ul className="flex flex-col">
            {found.data.map((choice) => (
              <li key={choice.id}>
                <button
                  type="button"
                  onClick={() => onPick(choice.chip)}
                  className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="truncate font-medium">{choice.label}</span>
                  {choice.detail ? (
                    <span className="truncate text-xs text-muted-foreground">{choice.detail}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
