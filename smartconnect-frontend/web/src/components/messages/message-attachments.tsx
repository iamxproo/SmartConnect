import { Button } from '@smartconnect/ui/components/button';
import { Download, File as FileIcon, FileText, FileX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ImagePreviewDialog } from '@/components/files/image-preview-dialog';
import { useToast } from '@/components/toast/toaster';
import { fetchFileContent } from '@/lib/api/file-transfer';
import { describeError } from '@/lib/api/messages';
import type { MessageAttachment, StoredFile } from '@/lib/api/types';
import { formatBytes, isPreviewableImage, typeLabel } from '@/lib/file-format';
import { useApi } from '@/lib/services';
import { ApiError } from '@/lib/api/errors';

const gone = (error: unknown) => error instanceof ApiError && error.status === 404;

/** The preview dialog shows a stored file; an attachment carries the same facts as a snapshot. */
const asStored = (a: MessageAttachment): StoredFile => ({
  id: a.fileId,
  name: a.name,
  mimeType: a.mimeType,
  sizeBytes: a.sizeBytes,
  status: 'available',
  uploadedByUserId: '',
  createdAt: '',
  updatedAt: '',
});

/** Files attached to a message: inline image types as thumbnails, everything else as a card with a download. */
export function MessageAttachments({ orgId, attachments }: { orgId: string; attachments: MessageAttachment[] }) {
  const [previewing, setPreviewing] = useState<StoredFile | null>(null);
  if (attachments.length === 0) return null;
  const images = attachments.filter((a) => isPreviewableImage(a.mimeType));
  const others = attachments.filter((a) => !isPreviewableImage(a.mimeType));
  return (
    <div className="flex flex-col gap-1.5">
      {images.length > 0 ? (
        <ul aria-label="Images" className="flex flex-wrap gap-2">
          {images.map((a) => (
            <li key={a.fileId}>
              <Thumbnail orgId={orgId} attachment={a} onOpen={() => setPreviewing(asStored(a))} />
            </li>
          ))}
        </ul>
      ) : null}
      {others.length > 0 ? (
        <ul aria-label="Files" className="flex flex-col gap-1.5">
          {others.map((a) => (
            <li key={a.fileId}>
              <FileCard orgId={orgId} attachment={a} />
            </li>
          ))}
        </ul>
      ) : null}
      <ImagePreviewDialog orgId={orgId} file={previewing} onClose={() => setPreviewing(null)} />
    </div>
  );
}

type Thumb = { state: 'idle' } | { state: 'ready'; url: string } | { state: 'gone' } | { state: 'failed' };

/** Loaded once it scrolls near the viewport, with the bearer token, into a short-lived object URL. */
function Thumbnail({
  orgId,
  attachment,
  onOpen,
}: {
  orgId: string;
  attachment: MessageAttachment;
  onOpen: () => void;
}) {
  const api = useApi();
  const box = useRef<HTMLDivElement>(null);
  // Without IntersectionObserver (old browsers, jsdom) the image is simply loaded.
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const [thumb, setThumb] = useState<Thumb>({ state: 'idle' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = box.current;
    if (!element || visible) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const abort = new AbortController();
    let url: string | undefined;
    fetchFileContent(api, orgId, attachment.fileId, abort.signal)
      .then((blob) => {
        url = URL.createObjectURL(blob);
        setThumb({ state: 'ready', url });
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) setThumb({ state: gone(error) ? 'gone' : 'failed' });
      });
    return () => {
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, orgId, attachment.fileId, visible, attempt]);

  if (thumb.state === 'gone') return <Unavailable name={attachment.name} />;
  return (
    <div
      ref={box}
      className="flex size-40 items-center justify-center overflow-hidden rounded-md border border-border bg-muted"
    >
      {thumb.state === 'ready' ? (
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Preview ${attachment.name}`}
          className="size-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <img src={thumb.url} alt={attachment.name} className="size-full object-cover" />
        </button>
      ) : thumb.state === 'failed' ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setThumb({ state: 'idle' });
            setAttempt((n) => n + 1);
          }}
        >
          Couldn&apos;t load. Retry
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">Loading…</span>
      )}
    </div>
  );
}

function Unavailable({ name }: { name: string }) {
  return (
    <div className="flex w-fit max-w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
      <FileX className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">{name}: file unavailable</span>
    </div>
  );
}

function FileCard({ orgId, attachment }: { orgId: string; attachment: MessageAttachment }) {
  const api = useApi();
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const [missing, setMissing] = useState(false);
  const Icon = attachment.mimeType === 'application/pdf' || attachment.mimeType === 'text/plain' ? FileText : FileIcon;

  async function download() {
    setDownloading(true);
    try {
      const url = URL.createObjectURL(await fetchFileContent(api, orgId, attachment.fileId));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = attachment.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      if (gone(error)) setMissing(true);
      else toast({ title: `Couldn't download ${attachment.name}`, description: describeError(error), tone: 'error' });
    } finally {
      setDownloading(false);
    }
  }

  if (missing) return <Unavailable name={attachment.name} />;
  return (
    <div className="flex w-fit max-w-full items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{attachment.name}</p>
        <p className="text-xs text-muted-foreground">
          {typeLabel(attachment.mimeType)} · {formatBytes(attachment.sizeBytes)}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        aria-label={`Download ${attachment.name}`}
        disabled={downloading}
        onClick={() => void download()}
      >
        <Download aria-hidden="true" />
      </Button>
    </div>
  );
}
