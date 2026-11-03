import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { Input } from '@smartconnect/ui/components/input';
import { Link, useRouter, useSearch } from '@tanstack/react-router';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { isSuperAdmin } from '@/lib/admin';
import { ApiError } from '@/lib/api/errors';
import { useAuthStore } from '@/lib/auth';
import { isEmail } from '@/lib/validation';
import { AuthCard } from '@/routes/auth/auth-layout';

/**
 * Platform administration sign-in (ADR 0015). It uses the ordinary login endpoint: there is one login system. An
 * account without the Super Admin role is signed straight back out here, and the admin APIs refuse it regardless.
 */
export function AdminLoginPage() {
  const auth = useAuthStore();
  const router = useRouter();
  const { redirect } = useSearch({ strict: false });
  const { formProps, errors, formError, pending } = useForm({
    fields: ['email', 'password'],
    validate: (values) => ({
      email: isEmail(values.email) ? undefined : 'Enter your admin ID (an email address).',
      password: values.password ? undefined : 'Enter your password.',
    }),
    submit: async (values) => {
      await auth.login(values.email.trim(), values.password);
      const state = auth.getState();
      if (state.status !== 'authenticated' || !isSuperAdmin(state.user)) {
        await auth.logout();
        throw new ApiError(403, { code: 'platform_admin_required' });
      }
      router.history.replace(state.user.passwordChangeRequired ? '/admin/password' : (redirect ?? '/admin'));
    },
  });

  return (
    <AuthCard title="Platform administration" description="Sign in with your Super Admin account.">
      <Alert tone="info">For SmartConnect platform administrators only. Organization admins sign in as usual.</Alert>
      <form {...formProps} className="flex flex-col gap-4">
        <FormError message={formError} />
        <Field label="Admin ID" hint="Your administrator email address." error={errors.email}>
          {(control) => <Input {...control} name="email" type="email" autoComplete="username" autoFocus />}
        </Field>
        <Field label="Password" error={errors.password}>
          {(control) => <Input {...control} name="password" type="password" autoComplete="current-password" />}
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <Link to="/login" className="text-sm text-primary underline-offset-4 hover:underline">
        Not an administrator? Sign in to SmartConnect
      </Link>
    </AuthCard>
  );
}
