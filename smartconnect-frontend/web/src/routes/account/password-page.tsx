import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { Input } from '@smartconnect/ui/components/input';
import { useState } from 'react';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { useToast } from '@/components/toast/toaster';
import { ApiError } from '@/lib/api/errors';
import { useChangePassword } from '@/lib/queries/account';
import { PASSWORD_MAX_LENGTH, passwordProblem } from '@/lib/validation';

export function PasswordPage() {
  const [version, setVersion] = useState(0);
  return (
    <section aria-labelledby="password-heading" className="flex flex-col gap-4">
      <h3 id="password-heading" className="font-medium">
        Change password
      </h3>
      <Alert tone="info">Changing your password signs you out on every other device. You stay signed in here.</Alert>
      {/* Remounting after a success clears the fields. */}
      <PasswordForm key={version} onChanged={() => setVersion(version + 1)} />
    </section>
  );
}

function PasswordForm({ onChanged }: { onChanged: () => void }) {
  const toast = useToast();
  const change = useChangePassword();
  const { formProps, errors, formError, pending } = useForm({
    fields: ['currentPassword', 'newPassword', 'confirmPassword'],
    validate: (values) => ({
      currentPassword: values.currentPassword ? undefined : 'Enter your current password.',
      newPassword: passwordProblem(values.newPassword),
      confirmPassword: values.confirmPassword === values.newPassword ? undefined : 'The passwords do not match.',
    }),
    submit: async (values) => {
      try {
        await change.mutateAsync({ currentPassword: values.currentPassword, newPassword: values.newPassword });
      } catch (error) {
        // A wrong current password is a 403; present it like a field error so it is announced on the field.
        if (error instanceof ApiError && error.code === 'current_password_incorrect') {
          throw new ApiError(422, {
            errors: [{ field: 'currentPassword', code: error.code, message: 'The current password is incorrect.' }],
          });
        }
        throw error;
      }
      toast({ title: 'Password changed', description: 'Your other devices were signed out.' });
      onChanged();
    },
  });
  return (
    <form {...formProps} aria-labelledby="password-heading" className="flex max-w-md flex-col gap-4">
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
      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Change password'}
        </Button>
      </div>
    </form>
  );
}
