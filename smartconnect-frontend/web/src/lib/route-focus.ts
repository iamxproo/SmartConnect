import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, type RefObject } from 'react';

/** After client-side navigation, moves focus to the new page content (the initial load keeps default focus). */
export function useFocusOnNavigate(target: RefObject<HTMLElement | null>) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    target.current?.focus();
  }, [pathname, target]);
  return pathname;
}
