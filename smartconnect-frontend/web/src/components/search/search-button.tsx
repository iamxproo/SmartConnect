import { Button } from '@smartconnect/ui/components/button';
import { Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useCurrentOrg } from '@/lib/queries/orgs';
import { SearchPalette } from './search-palette';

const shortcutLabel = () => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K');

/** Top-bar entry to the command palette, which also opens with Ctrl+K / Cmd+K anywhere inside an organization. */
export function SearchButton() {
  const { org } = useCurrentOrg();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const available = org !== undefined;

  useEffect(() => {
    if (!available) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [available]);

  if (!org) return null;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="text-muted-foreground max-md:size-9 max-md:p-0"
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        onClick={(event) => {
          opener.current = event.currentTarget;
          setOpen(true);
        }}
      >
        <Search aria-hidden="true" />
        {/* The name comes from the content (WCAG 2.5.3): visible on wide screens, screen-reader-only on narrow ones. */}
        <span className="max-md:sr-only">Search</span>
        {/* The shortcut hint is generated content, so it is not part of the (content-derived) name. */}
        <kbd
          aria-hidden="true"
          data-keys={shortcutLabel()}
          className="hidden rounded-sm border border-border px-1 font-sans text-xs after:content-[attr(data-keys)] md:inline"
        />
      </Button>
      <SearchPalette org={org} open={open} returnFocus={opener} onClose={() => setOpen(false)} />
    </>
  );
}
