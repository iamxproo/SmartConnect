import { Input } from '@smartconnect/ui/components/input';
import { cn } from '@smartconnect/ui/lib/utils';
import { Check } from 'lucide-react';
import { useId, useState, type KeyboardEvent } from 'react';
import { QueryState } from '@/components/states/query-state';
import type { Member } from '@/lib/api/types';
import { useMembers } from '@/lib/queries/orgs';

interface MemberPickerProps {
  orgId: string;
  label: string;
  /** People who cannot be chosen (yourself, current participants). */
  exclude: readonly string[];
  /** Already chosen (multi-select): shown with a check. */
  selected?: readonly string[];
  onPick: (member: Member) => void;
}

/**
 * Searchable list of the organization's active members (combobox + listbox): type to filter, Arrow keys to move,
 * Enter or click to choose.
 */
export function MemberPicker({ orgId, ...props }: MemberPickerProps) {
  const directory = useMembers(orgId);
  return (
    <QueryState query={directory} label="members">
      {(members) => <Picker members={members} {...props} />}
    </QueryState>
  );
}

function Picker({
  members,
  label,
  exclude,
  selected = [],
  onPick,
}: Omit<MemberPickerProps, 'orgId'> & { members: Member[] }) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const needle = query.trim().toLowerCase();
  const options = members.filter(
    (member) =>
      member.status === 'active' &&
      !exclude.includes(member.userId) &&
      (!needle || `${member.displayName} ${member.email}`.toLowerCase().includes(needle)),
  );
  const current = Math.min(active, options.length - 1);

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(options.length === 0 ? 0 : (current + step + options.length) % options.length);
    } else if (event.key === 'Enter') {
      // Never submit the surrounding form from here.
      event.preventDefault();
      const option = options[current];
      if (option) onPick(option);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        type="search"
        role="combobox"
        aria-label={label}
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={options[current] ? `${id}-${options[current].userId}` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        autoFocus
        placeholder="Search by name or email"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <ul
        id={`${id}-list`}
        role="listbox"
        aria-label={`${label} results`}
        aria-multiselectable="true"
        className="max-h-56 overflow-y-auto rounded-md border border-border"
      >
        {options.map((member, index) => (
          <li
            key={member.userId}
            id={`${id}-${member.userId}`}
            role="option"
            aria-selected={selected.includes(member.userId)}
            // Keep focus in the search box while pointing at an option.
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => onPick(member)}
            className={cn(
              'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm',
              index === current && 'bg-surface-hover',
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{member.displayName}</span>
              <span className="block truncate text-xs text-muted-foreground">{member.email}</span>
            </span>
            {selected.includes(member.userId) ? <Check className="size-4" aria-hidden="true" /> : null}
          </li>
        ))}
      </ul>
      {options.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          No matching members.
        </p>
      ) : null}
    </div>
  );
}
