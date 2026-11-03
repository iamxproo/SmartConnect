import { useRouter } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

/**
 * Reads `#token=…` from the URL fragment once, then removes the fragment so the secret does not linger in the
 * address bar or history. The token is kept in component state only.
 */
export function useHashToken(): string | null {
  const router = useRouter();
  const [token] = useState(() => new URLSearchParams(router.state.location.hash).get('token'));
  useEffect(() => {
    const { hash, pathname, searchStr } = router.state.location;
    if (hash) router.history.replace(`${pathname}${searchStr}`);
  }, [router]);
  return token;
}

// An invitation token must survive an in-app detour to sign in or register, but may not travel in a query
// string. It is kept in memory only: a full page reload drops it and the email link is opened again.
let pendingInvitationToken: string | null = null;
export const rememberInvitationToken = (token: string) => void (pendingInvitationToken = token);
export const recallInvitationToken = () => pendingInvitationToken;
export const forgetInvitationToken = () => void (pendingInvitationToken = null);
