import { Input } from '@smartconnect/ui/components/input';
import { useState } from 'react';
import { Field } from './field';

const slugify = (value: string) =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

/** Name + URL slug; the slug follows the name until the person edits it. */
export function NameSlugFields({ errors, nameLabel }: { errors: { name?: string; slug?: string }; nameLabel: string }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  return (
    <>
      <Field label={nameLabel} error={errors.name}>
        {(control) => (
          <Input
            {...control}
            name="name"
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              if (!slugEdited) setSlug(slugify(event.target.value));
            }}
          />
        )}
      </Field>
      <Field label="Address" hint="Lowercase letters, numbers and hyphens." error={errors.slug}>
        {(control) => (
          <Input
            {...control}
            name="slug"
            value={slug}
            autoComplete="off"
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(event.target.value);
            }}
          />
        )}
      </Field>
    </>
  );
}
