import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';

/**
 * The `?message=<id>` search parameter of a channel or conversation page: other screens (search, activity, saved)
 * link to a message with it, and the page opens the messages around it. `clear` leaves the message.
 */
export function useFocusedMessage(): { messageId: string | undefined; clear: () => void } {
  const message = useSearch({ strict: false, select: (search) => (search as { message?: unknown }).message });
  const navigate = useNavigate();
  const clear = useCallback(
    () => void navigate({ to: '.', search: (previous) => ({ ...previous, message: undefined }), replace: true }),
    [navigate],
  );
  return { messageId: typeof message === 'string' ? message : undefined, clear };
}
