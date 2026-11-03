import { Button } from '@smartconnect/ui/components/button';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '@/components/toast/toaster';
import { describeError } from '@/lib/api/messages';
import { useApi } from '@/lib/services';

/** Asks for a new verification email. The API answers 202 whether or not one is needed, so the wording is neutral. */
export function ResendVerification({ variant = 'outline' }: { variant?: 'outline' | 'link' }) {
  const api = useApi();
  const toast = useToast();
  const resend = useMutation({
    mutationFn: () => api.post('/auth/email/verification'),
    onSuccess: () =>
      toast({
        title: 'Verification email requested',
        description: 'If your address needs verifying, a new email is on its way.',
      }),
    onError: (error) => toast({ title: "Couldn't request an email", description: describeError(error), tone: 'error' }),
  });
  return (
    <Button variant={variant} size="sm" disabled={resend.isPending} onClick={() => resend.mutate()}>
      Resend verification email
    </Button>
  );
}
