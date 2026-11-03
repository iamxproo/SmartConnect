import { Button } from '@smartconnect/ui/components/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '@smartconnect/ui/components/dialog';
import { useState, type ReactNode } from 'react';
import { FormError } from './form-error';
import { useForm } from './use-form';

interface FormDialogProps<K extends string> {
  /** The element that opens the dialog (rendered with asChild). */
  trigger: ReactNode;
  title: string;
  description?: string;
  submitLabel: string;
  fields: readonly K[];
  validate?: (values: Record<K, string>) => Partial<Record<K, string>>;
  /** Throwing keeps the dialog open and shows the failure; resolving closes it. */
  submit: (values: Record<K, string>) => Promise<unknown>;
  messages?: Record<string, string>;
  children: (errors: Partial<Record<K, string>>) => ReactNode;
}

/** A modal form: Radix handles focus trapping/restoration; useForm handles validation and API errors. */
export function FormDialog<K extends string>({ trigger, title, description, children, ...form }: FormDialogProps<K>) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent {...(description ? {} : { 'aria-describedby': undefined })}>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
        <FormBody {...form} onDone={() => setOpen(false)}>
          {children}
        </FormBody>
      </DialogContent>
    </Dialog>
  );
}

// Separate component so the form state is created fresh each time the dialog opens.
function FormBody<K extends string>({
  submitLabel,
  submit,
  onDone,
  children,
  ...options
}: Omit<FormDialogProps<K>, 'trigger' | 'title' | 'description'> & { onDone: () => void }) {
  const { formProps, errors, formError, pending } = useForm({
    ...options,
    submit: async (values) => {
      await submit(values);
      onDone();
    },
  });
  return (
    <form {...formProps} className="mt-4 flex flex-col gap-4">
      <FormError message={formError} />
      {children(errors)}
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="outline">Cancel</Button>
        </DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
