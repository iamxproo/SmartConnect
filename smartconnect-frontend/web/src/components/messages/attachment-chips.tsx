import { Button } from '@smartconnect/ui/components/button';
import { Paperclip, RotateCw, X } from 'lucide-react';
import { formatBytes } from '@/lib/file-format';
import { MAX_ATTACHMENTS, type AttachmentDraft } from '@/lib/use-attachment-draft';

/** Files being attached to the message being written: progress, cancel, retry and remove. */
export function AttachmentChips({ draft }: { draft: AttachmentDraft }) {
  if (draft.attached.length === 0 && draft.uploads.length === 0 && !draft.limitHit) return null;
  return (
    <div className="flex flex-col gap-1">
      <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
        {draft.attached.map((file) => (
          <li
            key={`a${file.key}`}
            className="flex max-w-60 items-center gap-1.5 rounded-md border border-border bg-card py-1 pr-1 pl-2 text-xs"
          >
            <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate">{file.name}</span>
            <span className="shrink-0 text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label={`Remove ${file.name}`}
              onClick={() => draft.remove(file.key)}
            >
              <X aria-hidden="true" />
            </Button>
          </li>
        ))}
        {draft.uploads.map((item) => {
          const failed = item.status === 'failed';
          const percent = Math.round(item.progress * 100);
          return (
            <li
              key={`u${item.id}`}
              className="flex max-w-72 items-center gap-1.5 rounded-md border border-border bg-card py-1 pr-1 pl-2 text-xs"
            >
              <span className="truncate">{item.file.name}</span>
              {failed ? (
                <span role="alert" className="shrink-0 text-danger">
                  Failed. {item.error}
                </span>
              ) : (
                <progress
                  value={item.status === 'queued' ? undefined : percent}
                  max={100}
                  aria-label={`Uploading ${item.file.name}`}
                  className="h-1.5 w-16 shrink-0 accent-primary"
                />
              )}
              {failed && item.retryable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="size-6"
                  aria-label={`Retry ${item.file.name}`}
                  onClick={() => draft.retry(item.id)}
                >
                  <RotateCw aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-6"
                aria-label={`${failed ? 'Remove' : 'Cancel upload of'} ${item.file.name}`}
                onClick={() => draft.cancel(item.id)}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>
      {draft.limitHit ? (
        <p role="status" className="text-xs text-danger">
          A message can have at most {MAX_ATTACHMENTS} files. The rest were not added.
        </p>
      ) : null}
    </div>
  );
}
