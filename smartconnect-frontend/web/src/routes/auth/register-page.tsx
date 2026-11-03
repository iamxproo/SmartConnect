import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { Input } from '@smartconnect/ui/components/input';
import { Link, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { useApi } from '@/lib/services';
import { isEmail, passwordProblem } from '@/lib/validation';
import { AuthCard } from './auth-layout';

export function RegisterPage() {
  const api = useApi();
  const { redirect } = useSearch({ strict: false });
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const { formProps, errors, formError, pending } = useForm({
    fields: ['displayName', 'email', 'password'],
    validate: (values) => ({
      displayName: values.displayName.trim() ? undefined : 'Enter your name.',
      email: isEmail(values.email) ? undefined : 'Enter a valid email address.',
      password: passwordProblem(values.password),
    }),
    submit: async (values) => {
      const email = values.email.trim();
      // 202 for new and existing addresses alike: the API never says whether an account was created.
      await api.post(
        '/auth/register',
        { ...values, email, displayName: values.displayName.trim() },
        { anonymous: true },
      );
      setSubmittedEmail(email);
    },
  });

  if (submittedEmail) {
    return (
      <AuthCard title="Check your email">
        <Alert tone="info" role="status">
          If {submittedEmail} can be used for a new account, we've sent a message there with a link to verify your
          address. Open it, then sign in.
        </Alert>
        <Link to="/login" search={{ redirect }} className="text-sm text-primary underline-offset-4 hover:underline">
          Go to sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create an account"
      description="Joining a company still needs an invitation from its administrators."
    >
      <form {...formProps} className="flex flex-col gap-4">
        <FormError message={formError} />
        <Field label="Your name" error={errors.displayName}>
          {(control) => <Input {...control} name="displayName" autoComplete="name" maxLength={80} autoFocus />}
        </Field>
        <Field label="Email" error={errors.email}>
          {(control) => <Input {...control} name="email" type="email" autoComplete="email" />}
        </Field>
        <Field label="Password" hint="At least 12 characters." error={errors.password}>
          {(control) => <Input {...control} name="password" type="password" autoComplete="new-password" />}
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <Link to="/login" search={{ redirect }} className="text-sm text-primary underline-offset-4 hover:underline">
        I already have an account
      </Link>
    </AuthCard>
  );
}
