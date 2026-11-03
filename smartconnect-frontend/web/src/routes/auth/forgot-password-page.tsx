import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { Input } from '@smartconnect/ui/components/input';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { useApi } from '@/lib/services';
import { isEmail } from '@/lib/validation';
import { AuthCard } from './auth-layout';

export function ForgotPasswordPage() {
  const api = useApi();
  const [sent, setSent] = useState(false);
  const { formProps, errors, formError, pending } = useForm({
    fields: ['email'],
    validate: (values) => ({ email: isEmail(values.email) ? undefined : 'Enter a valid email address.' }),
    submit: async (values) => {
      await api.post('/auth/password/forgot', { email: values.email.trim() }, { anonymous: true });
      setSent(true);
    },
  });

  return (
    <AuthCard title="Reset your password" description="We'll email you a link to choose a new password.">
      {sent ? (
        <Alert tone="info" role="status">
          If an account exists for that address, we've sent instructions to reset the password. The link expires after a
          short time.
        </Alert>
      ) : (
        <form {...formProps} className="flex flex-col gap-4">
          <FormError message={formError} />
          <Field label="Email" error={errors.email}>
            {(control) => <Input {...control} name="email" type="email" autoComplete="email" autoFocus />}
          </Field>
          <Button type="submit" disabled={pending}>
            {pending ? 'Sending…' : 'Send reset link'}
          </Button>
        </form>
      )}
      <Link to="/login" search={{}} className="text-sm text-primary underline-offset-4 hover:underline">
        Back to sign in
      </Link>
    </AuthCard>
  );
}
