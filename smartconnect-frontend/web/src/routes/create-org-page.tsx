import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { Input } from '@smartconnect/ui/components/input';
import { useRouter } from '@tanstack/react-router';
import { ResendVerification } from '@/components/auth/resend-verification';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { NameSlugFields } from '@/components/form/name-slug-fields';
import { useForm } from '@/components/form/use-form';
import { PageContainer, PageHeader } from '@/components/page';
import { useToast } from '@/components/toast/toaster';
import { useUser } from '@/lib/auth';
import { useCreateOrg, useCreationEligibility } from '@/lib/queries/orgs';

/**
 * Self-service onboarding (ADR 0017): the creator becomes the owner and continues on the organization's overview, which
 * leads to inviting employees. Whether this server lets the person create one is asked first; a refusal from the
 * server is still reported as it is, never glossed over.
 */
export function CreateOrgPage() {
  const router = useRouter();
  const toast = useToast();
  const user = useUser();
  const createOrg = useCreateOrg();
  const eligibility = useCreationEligibility();
  const reason = eligibility.data?.allowed === false ? eligibility.data.reason : null;
  const { formProps, errors, formError, pending } = useForm({
    fields: ['name', 'slug', 'description'],
    validate: (values) => ({
      name: /[\p{L}\p{N}]/u.test(values.name) ? undefined : 'Enter the company name.',
      slug: values.slug.trim() ? undefined : 'Enter an address.',
    }),
    messages: { slug_taken: 'That address is already taken. Choose another.' },
    submit: async (values) => {
      const org = await createOrg.mutateAsync({
        name: values.name.trim(),
        slug: values.slug.trim(),
        ...(values.description.trim() ? { description: values.description.trim() } : {}),
      });
      toast({ title: `${org.name} was created`, description: 'Invite your team next.' });
      router.history.replace(`/o/${org.slug}`);
    },
  });

  return (
    <PageContainer>
      <PageHeader
        title="Create an organization"
        description="Your company's own space on SmartConnect. You'll be its owner, and you can invite your employees by email next."
      />
      {reason === 'email_not_verified' ? (
        <Alert tone="warning">
          Verify your email address first: open the link in the email we sent to {user.email}.
          <span className="mt-2 block">
            <ResendVerification variant="link" />
          </span>
        </Alert>
      ) : reason === 'limit_reached' ? (
        <Alert tone="warning">You already own the most organizations one account can have here.</Alert>
      ) : reason === 'not_allowed' ? (
        <Alert tone="warning">
          Organizations here are created by the platform's administrators. Ask the administrators of your company to
          invite you instead.
        </Alert>
      ) : null}
      <form {...formProps} className="flex max-w-md flex-col gap-4">
        <FormError message={formError} />
        <NameSlugFields errors={errors} nameLabel="Company name" />
        <Field label="Description (optional)" error={errors.description}>
          {(control) => <Input {...control} name="description" autoComplete="off" />}
        </Field>
        <Button type="submit" disabled={pending || reason !== null} className="self-start">
          {pending ? 'Creating…' : 'Create organization'}
        </Button>
      </form>
    </PageContainer>
  );
}
