import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { Link, useRouter } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError } from '@/lib/api/errors';
import { describeError } from '@/lib/api/messages';
import type { InvitationPreview } from '@/lib/api/types';
import { useAuthState, useAuthStore } from '@/lib/auth';
import { forgetInvitationToken, recallInvitationToken, rememberInvitationToken, useHashToken } from '@/lib/hash-token';
import { orgsKey } from '@/lib/queries/orgs';
import { useApi } from '@/lib/services';
import { useToast } from '@/components/toast/toaster';
import { ResendVerification } from '@/components/auth/resend-verification';
import { AuthCard } from './auth-layout';

const ACCEPT_PATH = '/invitations/accept';

const ACCEPT_MESSAGES = {
  already_member: "You're already a member of this organization.",
};

export function InvitationAcceptPage() {
  const api = useApi();
  const auth = useAuthStore();
  const state = useAuthState();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();
  const fragmentToken = useHashToken();
  const [token] = useState(() => fragmentToken ?? recallInvitationToken());

  useEffect(() => {
    // Survives the in-app detour to sign in / register; never travels in a URL.
    if (token) rememberInvitationToken(token);
  }, [token]);

  const preview = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: () => api.post<InvitationPreview>('/invitations/preview', { token }, { anonymous: true }),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
  });

  const accept = useMutation({
    mutationFn: () => api.post('/invitations/accept', { token }),
    onSuccess: async () => {
      forgetInvitationToken();
      await queryClient.invalidateQueries({ queryKey: orgsKey });
      const name = preview.data?.organization.name;
      toast({ title: name ? `You joined ${name}` : 'Invitation accepted' });
      router.history.replace(`/o/${preview.data?.organization.slug ?? ''}`);
    },
    onError: (error) => {
      // The accept call is the first to learn the address is still unverified (e.g. verified in another tab).
      if (error instanceof ApiError && error.code === 'email_not_verified') void auth.reloadUser();
    },
  });

  if (!token) {
    return (
      <AuthCard title="Invitation link incomplete">
        <Alert tone="warning">
          This link is missing its token. Open the link from your invitation email again. If you reloaded this page
          after signing in, use the email link again too.
        </Alert>
      </AuthCard>
    );
  }
  if (preview.isPending) {
    return (
      <AuthCard title="Invitation">
        <p role="status" className="text-sm text-muted-foreground">
          Checking your invitation…
        </p>
      </AuthCard>
    );
  }
  if (preview.isError) {
    return (
      <AuthCard title="Invitation unavailable">
        <Alert tone="danger" role="alert">
          {describeError(preview.error)}
        </Alert>
      </AuthCard>
    );
  }

  const { organization, role, emailHint } = preview.data;
  const heading = `Join ${organization.name}`;
  const summary = `You've been invited as ${role.name}. The invitation was sent to ${emailHint}.`;

  if (state.status !== 'authenticated') {
    return (
      <AuthCard title={heading} description={summary}>
        <p className="text-sm">Sign in, or create an account, with the invited email address to accept.</p>
        <Button asChild>
          <Link to="/login" search={{ redirect: ACCEPT_PATH }}>
            Sign in
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/register" search={{ redirect: ACCEPT_PATH }}>
            Create an account
          </Link>
        </Button>
      </AuthCard>
    );
  }

  if (!state.user.emailVerified) {
    return (
      <AuthCard title={heading} description={summary}>
        <Alert tone="warning">
          Verify your email address before accepting. Open the link in the email we sent to {state.user.email}; it may
          take a moment to arrive.
        </Alert>
        <ResendVerification />
        <Button variant="outline" onClick={() => void auth.reloadUser()}>
          I've verified my email
        </Button>
      </AuthCard>
    );
  }

  const failure = accept.error ? describeError(accept.error, ACCEPT_MESSAGES) : null;
  const failureCode = accept.error instanceof ApiError ? accept.error.code : undefined;
  return (
    <AuthCard title={heading} description={summary}>
      <p className="text-sm">
        You're signed in as <strong>{state.user.email}</strong>.
      </p>
      {failure ? (
        <Alert tone="danger" role="alert">
          {failure}
        </Alert>
      ) : null}
      {failureCode === 'already_member' ? (
        <Button asChild>
          <Link to="/o/$orgSlugOrId" params={{ orgSlugOrId: organization.slug }}>
            Open {organization.name}
          </Link>
        </Button>
      ) : (
        <Button disabled={accept.isPending} onClick={() => accept.mutate()}>
          {accept.isPending ? 'Accepting…' : 'Accept invitation'}
        </Button>
      )}
      {failureCode === 'invitation_email_mismatch' ? (
        <Button variant="outline" onClick={() => void auth.logout()}>
          Sign out and use another account
        </Button>
      ) : null}
    </AuthCard>
  );
}
