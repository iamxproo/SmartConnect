import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { Input } from '@smartconnect/ui/components/input';
import { Navigate, useRouter } from '@tanstack/react-router';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { ApiError } from '@/lib/api/errors';
import { useAuthStore, useUser } from '@/lib/auth';
import { useChangePassword } from '@/lib/queries/account';
import { PASSWORD_MAX_LENGTH, passwordProblem } from '@/lib/validation';

/**
 * First sign-in of a Super Admin holding an issued password (ADR 0015): nothing else is reachable until it is replaced.
 * The server enforces this (every admin API answers 403 password_change_required); this page is the way through.
 */
export function AdminPasswordPage() {
  const user = useUser();
  const auth = useAuthStore();
  const router = useRouter();
  const change = useChangePassword();
  const { formProps, errors, formError, pending } = useForm({
    fields: ['currentPassword', 'newPassword', 'confirmPassword'],
    validate: (values) => ({
      currentPassword: values.currentPassword ? undefined : 'Enter the password you signed in with.',
      newPassword: passwordProblem(values.newPassword),
      confirmPassword: values.confirmPassword === values.newPassword ? undefined : 'The passwords do not match.',
    }),
    submit: async (values) => {
      try {
        await change.mutateAsync({ currentPassword: values.currentPassword, newPassword: values.newPassword });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'current_password_incorrect') {
          throw new ApiError(422, {
            errors: [{ field: 'currentPassword', code: error.code, message: 'The current password is incorrect.' }],
          });
        }
        throw error;
      }
      await auth.reloadUser();
      router.history.replace('/admin');
    },
  });

  if (!user.passwordChangeRequired) return <Navigate to="/admin" replace />;
  return (
    <section aria-labelledby="admin-password-heading" className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 id="admin-password-heading" className="text-xl font-semibold">
        Choose your password
      </h1>
      <Alert tone="warning">
        You signed in with an initial password. Replace it with your own before using platform administration.
      </Alert>
      <form {...formProps} aria-labelledby="admin-password-heading" className="flex flex-col gap-4">
        <FormError message={formError} />
        <Field label="Current password" error={errors.currentPassword}>
          {(control) => (
            <Input
              {...control}
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              maxLength={PASSWORD_MAX_LENGTH}
            />
          )}
        </Field>
        <Field label="New password" hint="At least 12 characters." error={errors.newPassword}>
          {(control) => (
            <Input
              {...control}
              name="newPassword"
              type="password"
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
            />
          )}
        </Field>
        <Field label="Confirm new password" error={errors.confirmPassword}>
          {(control) => <Input {...control} name="confirmPassword" type="password" autoComplete="new-password" />}
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save and continue'}
        </Button>
      </form>
    </section>
  );
}
