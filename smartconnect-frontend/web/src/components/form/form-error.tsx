import { Alert } from '@smartconnect/ui/components/alert';

/** Form-level failure, announced immediately to screen readers. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert tone="danger" role="alert">
      {message}
    </Alert>
  );
}
