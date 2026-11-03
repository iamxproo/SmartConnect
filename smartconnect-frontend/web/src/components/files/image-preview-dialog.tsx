import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@smartconnect/ui/components/dialog';
import { useEffect, useState } from 'react';
import { ErrorState } from '@/components/states/error-state';
import { LoadingState } from '@/components/states/loading-state';
import { fetchFileContent } from '@/lib/api/file-transfer';
import { describeError } from '@/lib/api/messages';
import type { StoredFile } from '@/lib/api/types';
import { formatBytes } from '@/lib/file-format';
import { useApi } from '@/lib/services';

type Preview = { state: 'loading' } | { state: 'ready'; url: string } | { state: 'failed'; message: string };

/** Shows an inline-safe image (PNG, JPEG, GIF, WebP). The bytes are fetched with the bearer token and shown from a
 * short-lived object URL, so the image never needs a credential in its address. */
export function ImagePreviewDialog({
  orgId,
  file,
  onClose,
}: {
  orgId: string;
  file: StoredFile | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        {file ? <PreviewBody key={file.id} orgId={orgId} file={file} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ orgId, file }: { orgId: string; file: StoredFile }) {
  const api = useApi();
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    let url: string | undefined;
    fetchFileContent(api, orgId, file.id, abort.signal)
      .then((blob) => {
        url = URL.createObjectURL(blob);
        setPreview({ state: 'ready', url });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setPreview({ state: 'failed', message: describeError(error) });
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, orgId, file.id, attempt]);

  return (
    <>
      <DialogTitle className="truncate pr-8">{file.name}</DialogTitle>
      <DialogDescription>{formatBytes(file.sizeBytes)}</DialogDescription>
      <div className="mt-4 flex min-h-40 items-center justify-center">
        {preview.state === 'loading' ? <LoadingState label="Loading preview" /> : null}
        {preview.state === 'failed' ? (
          <ErrorState
            title="Couldn't load the preview"
            description={preview.message}
            onRetry={() => {
              setPreview({ state: 'loading' });
              setAttempt((count) => count + 1);
            }}
          />
        ) : null}
        {preview.state === 'ready' ? (
          <img src={preview.url} alt={file.name} className="max-h-[65dvh] max-w-full rounded-md object-contain" />
        ) : null}
      </div>
    </>
  );
}
