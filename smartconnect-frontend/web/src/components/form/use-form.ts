import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api/errors';
import { describeError } from '@/lib/api/messages';

type Values<K extends string> = Record<K, string>;
type Errors<K extends string> = Partial<Record<K, string>>;

interface UseFormOptions<K extends string> {
  /** Names of the form's fields: a 422 error for any other field is shown in the form-level message. */
  fields: readonly K[];
  validate?: (values: Values<K>) => Errors<K>;
  submit: (values: Values<K>) => Promise<unknown>;
  /** Wording for error codes specific to this form. */
  messages?: Record<string, string>;
}

/**
 * Uncontrolled form: reads values on submit, validates, calls `submit`, and maps API errors back to the fields
 * (422 `errors[]`) or to a form-level message. The first invalid field is focused so the error is announced.
 */
export function useForm<K extends string>({ fields, validate, submit, messages }: UseFormOptions<K>) {
  const ref = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<Errors<K>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [errors]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = data.get(name);
      return typeof value === 'string' ? value : '';
    };
    const values = Object.fromEntries(fields.map((name) => [name, text(name)])) as Values<K>;
    const invalid = Object.fromEntries(
      Object.entries(validate?.(values) ?? {}).filter(([, message]) => message),
    ) as Errors<K>;
    setFormError(null);
    setErrors(invalid);
    if (Object.keys(invalid).length > 0) return;

    setPending(true);
    try {
      await submit(values);
    } catch (error) {
      const mapped: Errors<K> = {};
      const unmapped: string[] = [];
      if (error instanceof ApiError && error.status === 422) {
        for (const item of error.errors) {
          if ((fields as readonly string[]).includes(item.field)) mapped[item.field as K] ??= item.message;
          else unmapped.push(item.message);
        }
      }
      setErrors(mapped);
      if (Object.keys(mapped).length === 0 || unmapped.length > 0) {
        setFormError(unmapped.length > 0 ? unmapped.join(' ') : describeError(error, messages));
      }
    } finally {
      setPending(false);
    }
  }

  return { formProps: { ref, onSubmit, noValidate: true }, errors, formError, setFormError, pending };
}
