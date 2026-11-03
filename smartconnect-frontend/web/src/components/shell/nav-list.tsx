import { Tooltip, TooltipContent, TooltipTrigger } from '@smartconnect/ui/components/tooltip';
import { cn } from '@smartconnect/ui/lib/utils';
import { Link, type LinkComponentProps } from '@tanstack/react-router';
import { LayoutGroup, motion } from 'motion/react';
import { useId, type ReactNode } from 'react';
import { enterTransition } from '@/lib/motion';
import type { NavMeta } from './navigation';

type NavEntry = LinkComponentProps<'a'> & NavMeta;

interface NavListProps {
  items: readonly NavEntry[];
  /** Icon-only rail: labels stay in the accessible name (sr-only) and appear as tooltips. */
  collapsed: boolean;
  onNavigate?: () => void;
  /** Entries gated by a permission are shown only when this returns true. */
  allows?: (permission: string) => boolean;
}

export function NavList({ items, collapsed, onNavigate, allows }: NavListProps) {
  // Each list (desktop rail, mobile sheet) owns its sliding active indicator.
  const group = useId();
  return (
    <LayoutGroup id={group}>
      <ul className="flex flex-col gap-0.5">
        {items
          .filter((item) => !item.permission || allows?.(item.permission))
          .map(({ label, icon, available, permission: _permission, exact, ...link }) => (
            <li key={`${link.to}`}>
              <NavLink
                collapsed={collapsed}
                label={label}
                available={available}
                onNavigate={onNavigate}
                icon={icon}
                link={link}
                exact={exact}
              />
            </li>
          ))}
      </ul>
    </LayoutGroup>
  );
}

interface NavLinkProps {
  label: string;
  icon: NavMeta['icon'];
  available: boolean;
  exact?: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
  link: LinkComponentProps<'a'>;
}

export function NavLink({ label, icon: Icon, available, exact, collapsed, onNavigate, link }: NavLinkProps) {
  const anchor = (
    <Link
      {...link}
      onClick={onNavigate}
      activeOptions={{ exact: exact ?? false }}
      className={cn(
        'relative flex h-9 items-center gap-3 rounded-md px-2.5 text-sm text-muted-foreground',
        'transition-colors duration-(--sc-duration-fast) ease-standard hover:bg-surface-hover hover:text-foreground',
        'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        'data-[status=active]:font-medium data-[status=active]:text-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      {({ isActive }: { isActive: boolean }): ReactNode => (
        <>
          {isActive ? (
            <motion.span
              layoutId="nav-active"
              aria-hidden="true"
              className="absolute inset-0 rounded-md bg-surface-selected"
              transition={enterTransition}
            />
          ) : null}
          <Icon className="relative size-4 shrink-0" aria-hidden="true" />
          <span className={cn('relative truncate', collapsed && 'sr-only')}>{label}</span>
          {!available ? (
            <>
              <span className="sr-only">, not available yet</span>
              {!collapsed ? (
                <span
                  aria-hidden="true"
                  className="relative ml-auto rounded-sm border border-border px-1.5 text-xs leading-5 text-muted-foreground"
                >
                  Soon
                </span>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </Link>
  );

  if (!collapsed) return anchor;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{anchor}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}
