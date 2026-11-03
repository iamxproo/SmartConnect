import { Button } from '@smartconnect/ui/components/button';
import { Input } from '@smartconnect/ui/components/input';
import { Link, useRouter, useSearch } from '@tanstack/react-router';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { useForm } from '@/components/form/use-form';
import { useAuthStore } from '@/lib/auth';
import { isEmail } from '@/lib/validation';
import { AuthCard } from './auth-layout';

export function LoginPage() {
  const auth = useAuthStore();
  const router = useRouter();
  const { redirect } = useSearch({ strict: false });
  const { formProps, errors, formError, pending } = useForm({
    fields: ['email', 'password'],
    validate: (values) => ({
      email: isEmail(values.email) ? undefined : 'Enter your email address.',
      password: values.password ? undefined : 'Enter your password.',
    }),
    submit: async (values) => {
      await auth.login(values.email.trim(), values.password);
      router.history.replace(redirect ?? '/');
    },
  });

  return (
    <AuthCard title="Sign in" description="Use the account you registered with your company email.">
      <form {...formProps} className="flex flex-col gap-4">
        <FormError message={formError} />
        <Field label="Email" error={errors.email}>
          {(control) => <Input {...control} name="email" type="email" autoComplete="username" autoFocus />}
        </Field>
        <Field label="Password" error={errors.password}>
          {(control) => <Input {...control} name="password" type="password" autoComplete="current-password" />}
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <div className="flex flex-col gap-1 text-sm">
        <Link to="/forgot-password" className="text-primary underline-offset-4 hover:underline">
          Forgot your password?
        </Link>
        <Link to="/register" search={{ redirect }} className="text-primary underline-offset-4 hover:underline">
          Create an account
        </Link>
      </div>
    </AuthCard>
  );
}
