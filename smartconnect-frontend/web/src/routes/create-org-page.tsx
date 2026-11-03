import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { Input } from '@smartconnect/ui/components/input';
import { useRouter } from '@tanstack/react-router';
import { Field } from '@/components/form/field';
import { FormError } from '@/components/form/form-error';
import { NameSlugFields } from '@/components/form/name-slug-fields';
import { useForm } from '@/components/form/use-form';
import { PageContainer, PageHeader } from '@/components/page';
import { useToast } from '@/components/toast/toaster';
import { useCreateOrg } from '@/lib/queries/orgs';

/** Creating a company is restricted to authorized administrators; a 403 is reported, never glossed over. */
export function CreateOrgPage() {
  const router = useRouter();
  const toast = useToast();
  const createOrg = useCreateOrg();
  const { formProps, errors, formError, pending } = useForm({
    fields: ['name', 'slug', 'description'],
    validate: (values) => ({
      name: values.name.trim() ? undefined : 'Enter the company name.',
      slug: values.slug.trim() ? undefined : 'Enter an address.',
    }),
    messages: { slug_taken: 'That address is already taken. Choose another.' },
    submit: async (values) => {
      const org = await createOrg.mutateAsync({
        name: values.name.trim(),
        slug: values.slug.trim(),
        ...(values.description.trim() ? { description: values.description.trim() } : {}),
      });
      toast({ title: `${org.name} was created` });
      router.history.replace(`/o/${org.slug}`);
    },
  });

  return (
    <PageContainer>
      <PageHeader title="Create an organization" />
      <Alert>
        Companies are created by authorized administrators. If your account is not authorized, the request is refused;
        ask the administrators of your company to invite you instead.
      </Alert>
      <form {...formProps} className="flex max-w-md flex-col gap-4">
        <FormError message={formError} />
        <NameSlugFields errors={errors} nameLabel="Company name" />
        <Field label="Description (optional)" error={errors.description}>
          {(control) => <Input {...control} name="description" autoComplete="off" />}
        </Field>
        <Button type="submit" disabled={pending} className="self-start">
          {pending ? 'Creating…' : 'Create organization'}
        </Button>
      </form>
    </PageContainer>
  );
}
