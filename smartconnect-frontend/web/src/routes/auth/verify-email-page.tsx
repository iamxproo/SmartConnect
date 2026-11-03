import { Alert } from '@smartconnect/ui/components/alert';
import { Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useAuthStore } from '@/lib/auth';
import { describeError } from '@/lib/api/messages';
import { useHashToken } from '@/lib/hash-token';
import { useApi } from '@/lib/services';
import { AuthCard } from './auth-layout';

export function VerifyEmailPage() {
  const api = useApi();
  const auth = useAuthStore();
  const token = useHashToken();
  const started = useRef(false);
  const verify = useMutation({
    mutationFn: async (value: string) => {
      await api.post('/auth/email/verify', { token: value }, { anonymous: true });
      // If this browser is signed in, the banner and permissions must reflect the verified address.
      if (auth.getState().status === 'authenticated') await auth.reloadUser();
    },
  });

  useEffect(() => {
    // Single use: StrictMode runs effects twice in development, so the request is guarded.
    if (!token || started.current) return;
    started.current = true;
    verify.mutate(token);
  }, [token, verify]);

  return (
    <AuthCard title="Verify your email">
      {!token ? (
        <Alert tone="warning">This link is missing its token. Open the link from the email again.</Alert>
      ) : verify.isSuccess ? (
        <Alert tone="success" role="status">
          Your email address is verified.
        </Alert>
      ) : verify.isError ? (
        <Alert tone="danger" role="alert">
          {describeError(verify.error)}
        </Alert>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Verifying your address…
        </p>
      )}
      <Link to="/" className="text-sm text-primary underline-offset-4 hover:underline">
        Continue to SmartConnect
      </Link>
    </AuthCard>
  );
}
