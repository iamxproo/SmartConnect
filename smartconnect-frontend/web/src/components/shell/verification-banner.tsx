import { Alert } from '@smartconnect/ui/components/alert';
import { useEffect } from 'react';
import { ResendVerification } from '@/components/auth/resend-verification';
import { useAuthStore, useUser } from '@/lib/auth';

/** Shown while the signed-in address is unverified: verification gates creating organizations and accepting invitations. */
export function VerificationBanner() {
  const user = useUser();
  const auth = useAuthStore();

  // The verification link usually opens in another tab; pick up the result when this one regains focus.
  useEffect(() => {
    if (user.emailVerified) return;
    const reload = () => void auth.reloadUser().catch(() => undefined);
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [auth, user.emailVerified]);

  if (user.emailVerified) return null;
  return (
    <Alert tone="warning" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-none border-x-0 border-t-0">
      <span className="min-w-0 flex-1">
        Verify <strong>{user.email}</strong> to create organizations or accept invitations. Check your inbox for the
        link.
      </span>
      <ResendVerification />
    </Alert>
  );
}
