import { Button } from '@smartconnect/ui/components/button';
import { cn } from '@smartconnect/ui/lib/utils';
import {
  Download,
  File as FileIcon,
  FileText,
  Folder,
  Image as ImageIcon,
  RotateCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog';
import { ImagePreviewDialog } from '@/components/files/image-preview-dialog';
import { RevealItem } from '@/components/motion/reveal';
import { Card, PageContainer, PageHeader } from '@/components/page';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import { useToast } from '@/components/toast/toaster';
import { fetchFileContent } from '@/lib/api/file-transfer';
import { describeError } from '@/lib/api/messages';
import type { StoredFile } from '@/lib/api/types';
import { formatBytes, isPreviewableImage, typeLabel } from '@/lib/file-format';
import { useDeleteFile, useFiles } from '@/lib/queries/files';
import { useRequiredOrg } from '@/lib/queries/orgs';
import { formatRelative } from '@/lib/relative-time';
import { useApi } from '@/lib/services';
import { useUploads, type UploadItem } from '@/lib/use-uploads';

export function FilesPage() {
  const org = useRequiredOrg();
  const files = useFiles(org.id);
  const uploads = useUploads(org.id);
  const [previewing, setPreviewing] = useState<StoredFile | null>(null);

  return (
    <PageContainer>
      <PageHeader title="Files" description="Files you upload are private to you." />
      <DropZone onFiles={uploads.add} />
      {uploads.items.length > 0 ? (
        <ul aria-label="Uploads" className="flex flex-col gap-2">
          {uploads.items.map((item) => (
            <UploadRow key={item.id} item={item} onRetry={uploads.retry} onDismiss={uploads.dismiss} />
          ))}
        </ul>
      ) : null}
      <QueryState query={files} label="files">
        {(list) =>
          list.length === 0 ? (
            <EmptyState
              icon={Folder}
              title="No files yet"
              description="Drop files above or choose them from your device. They appear here once uploaded."
            />
          ) : (
            <ul aria-label="Your files" className="flex flex-col gap-2">
              {list.map((file, index) => (
                <RevealItem key={file.id} index={index} hoverLift>
                  <FileRow file={file} onPreview={setPreviewing} />
                </RevealItem>
              ))}
            </ul>
          )
        }
      </QueryState>
      <ImagePreviewDialog orgId={org.id} file={previewing} onClose={() => setPreviewing(null)} />
    </PageContainer>
  );
}

function DropZone({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter/leave also fire for children; a counter keeps the highlight steady.
  const depth = useRef(0);

  function enter(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  }
  function leave() {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    const dropped = [...event.dataTransfer.files];
    if (dropped.length > 0) onFiles(dropped);
  }

  return (
    <div
      role="group"
      aria-label="Upload files"
      onDragEnter={enter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={leave}
      onDrop={drop}
      className={cn(
        'flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border px-4 py-8 text-center',
        'transition-colors duration-(--sc-duration-base) ease-standard',
        dragging && 'border-primary bg-surface-selected',
      )}
    >
      <Upload className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{dragging ? 'Drop to upload' : 'Drag files here, or'}</p>
      <Button variant="outline" onClick={() => input.current?.click()}>
        Choose files
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose files to upload"
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          event.target.value = ''; // the same file can be chosen again after a failure
        }}
      />
    </div>
  );
}

function UploadRow({
  item,
  onRetry,
  onDismiss,
}: {
  item: UploadItem;
  onRetry: (id: number) => void;
  onDismiss: (id: number) => void;
}) {
  const percent = Math.round(item.progress * 100);
  const failed = item.status === 'failed';
  return (
    <li>
      <Card className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{item.file.name}</p>
          {failed ? (
            <p role="alert" className="text-sm text-danger">
              Upload failed. {item.error}
            </p>
          ) : (
            <>
              <progress
                value={item.status === 'queued' ? undefined : percent}
                max={100}
                aria-label={`Uploading ${item.file.name}`}
                className="mt-1 h-2 w-full overflow-hidden rounded-full accent-primary"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {item.status === 'queued' ? 'Waiting…' : `${percent}% of ${formatBytes(item.file.size)}`}
              </p>
            </>
          )}
        </div>
        {failed && item.retryable ? (
          <Button variant="outline" size="sm" onClick={() => onRetry(item.id)}>
            <RotateCw aria-hidden="true" />
            Retry
          </Button>
        ) : null}
        {failed || item.status === 'queued' ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${failed ? 'Dismiss' : 'Cancel'} ${item.file.name}`}
            onClick={() => onDismiss(item.id)}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </Card>
    </li>
  );
}

function FileTypeIcon({ mimeType }: { mimeType: string }) {
  const className = 'size-5 shrink-0 text-muted-foreground';
  if (isPreviewableImage(mimeType)) return <ImageIcon className={className} aria-hidden="true" />;
  if (mimeType === 'application/pdf' || mimeType === 'text/plain' || mimeType.includes('officedocument'))
    return <FileText className={className} aria-hidden="true" />;
  return <FileIcon className={className} aria-hidden="true" />;
}

function FileRow({ file, onPreview }: { file: StoredFile; onPreview: (file: StoredFile) => void }) {
  const org = useRequiredOrg();
  const api = useApi();
  const toast = useToast();
  const remove = useDeleteFile(org.id);
  const [deleting, setDeleting] = useState(false);
  const [downloading, setDownloading] = useState(false);

  async function download() {
    setDownloading(true);
    try {
      const url = URL.createObjectURL(await fetchFileContent(api, org.id, file.id));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (error) {
      toast({ title: `Couldn't download ${file.name}`, description: describeError(error), tone: 'error' });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Card className="flex items-center gap-3">
      <FileTypeIcon mimeType={file.mimeType} />
      <div className="min-w-0 flex-1">
        {isPreviewableImage(file.mimeType) ? (
          <button
            type="button"
            onClick={() => onPreview(file)}
            aria-label={`Preview ${file.name}`}
            className="block max-w-full truncate rounded-sm text-left font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {file.name}
          </button>
        ) : (
          <p className="truncate font-medium">{file.name}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {typeLabel(file.mimeType)} · {formatBytes(file.sizeBytes)} · {formatRelative(file.createdAt)}
        </p>
      </div>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`Download ${file.name}`}
        disabled={downloading}
        onClick={() => void download()}
      >
        <Download aria-hidden="true" />
      </Button>
      <Button variant="outline" size="icon-sm" aria-label={`Delete ${file.name}`} onClick={() => setDeleting(true)}>
        <Trash2 aria-hidden="true" />
      </Button>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${file.name}?`}
        description="The file is removed and can't be recovered."
        confirmLabel="Delete file"
        onConfirm={async () => {
          await remove.mutateAsync(file.id);
          toast({ title: `${file.name} was deleted` });
        }}
      />
    </Card>
  );
}
