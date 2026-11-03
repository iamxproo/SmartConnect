import { useMatches } from '@tanstack/react-router';
import { useEffect } from 'react';

export const APP_NAME = 'SmartConnect';

/** Title from the deepest matching route's staticData; also sets document.title. */
export function usePageTitle(): string {
  const matches = useMatches();
  let title = 'Page not found';
  for (let index = matches.length - 1; index >= 0; index--) {
    const candidate = matches[index]?.staticData.title;
    if (candidate) {
      title = candidate;
      break;
    }
  }
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
  return title;
}
