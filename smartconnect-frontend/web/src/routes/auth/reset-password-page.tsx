import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { Input } from '@smartconnect/ui/components/input';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { useHashToken } from '@/lib/hash-token';
import { useApi } from '@/lib/services';
import { passwordProblem } from '@/lib/validation';
import { AuthCard } from './auth-layout';

export function ResetPasswordPage() {
  const api = useApi();
  const token = useHashToken();
  const [done, setDone] = useState(false);
  const { formProps, errors, formError, pending } = useForm({
    fields: ['newPassword', 'confirmPassword'],
    validate: (values) => ({
      newPassword: passwordProblem(values.newPassword),
      confirmPassword: values.confirmPassword === values.newPassword ? undefined : 'The passwords do not match.',
    }),
    submit: async (values) => {
      await api.post('/auth/password/reset', { token, newPassword: values.newPassword }, { anonymous: true });
      setDone(true);
    },
  });

  if (done) {
    return (
      <AuthCard title="Password updated">
        <Alert tone="success" role="status">
          Your password was changed and every device was signed out. Sign in with the new password.
        </Alert>
        <Link to="/login" search={{}} className="text-sm text-primary underline-offset-4 hover:underline">
          Go to sign in
        </Link>
      </AuthCard>
    );
  }

  if (!token) {
    return (
      <AuthCard title="Reset link incomplete">
        <Alert tone="warning">
          This link is missing its token. Open the link from the email again, or request a new one.
        </Alert>
        <Link to="/forgot-password" className="text-sm text-primary underline-offset-4 hover:underline">
          Request a new link
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password">
      <form {...formProps} className="flex flex-col gap-4">
        <FormError message={formError} />
        <Field label="New password" hint="At least 12 characters." error={errors.newPassword}>
          {(control) => <Input {...control} name="newPassword" type="password" autoComplete="new-password" autoFocus />}
        </Field>
        <Field label="Confirm new password" error={errors.confirmPassword}>
          {(control) => <Input {...control} name="confirmPassword" type="password" autoComplete="new-password" />}
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Change password'}
        </Button>
      </form>
      <Link to="/forgot-password" className="text-sm text-primary underline-offset-4 hover:underline">
        Request a new link
      </Link>
    </AuthCard>
  );
}
