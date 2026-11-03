import { useCallback, useState } from 'react';
import type { MessageAttachment } from '@/lib/api/types';
import { useUploads, type UploadItem } from '@/lib/use-uploads';

export const MAX_ATTACHMENTS = 10;

/** An uploaded file waiting to be sent with a message. `key` identifies the chip. */
export interface DraftAttachment extends MessageAttachment {
  key: number;
}

export interface AttachmentDraft {
  /** Uploaded and ready to send, in order. */
  attached: DraftAttachment[];
  /** Waiting, uploading or failed uploads. */
  uploads: UploadItem[];
  /** Something is still on its way: sending waits. */
  busy: boolean;
  /** The last `add` dropped files beyond the limit. */
  limitHit: boolean;
  add: (files: File[]) => void;
  retry: (id: number) => void;
  /** Cancels an upload or dismisses a failed one. */
  cancel: (id: number) => void;
  remove: (key: number) => void;
  /** After a successful send. */
  clear: () => void;
}

/** The files of a message being written: uploads through the Files helper, up to 10 per message. */
export function useAttachmentDraft(orgId: string): AttachmentDraft {
  const [attached, setAttached] = useState<DraftAttachment[]>([]);
  const [limitHit, setLimitHit] = useState(false);
  const uploads = useUploads(orgId, (item, stored) =>
    setAttached((list) => [
      ...list,
      { key: item.id, fileId: stored.id, name: stored.name, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes },
    ]),
  );
  const { items, add: addUploads, dismiss } = uploads;

  const add = useCallback(
    (files: File[]) => {
      const room = Math.max(0, MAX_ATTACHMENTS - attached.length - items.length);
      setLimitHit(files.length > room);
      if (room > 0) addUploads(files.slice(0, room));
    },
    [addUploads, attached.length, items.length],
  );
  const clear = useCallback(() => {
    setAttached([]);
    setLimitHit(false);
    for (const item of items) dismiss(item.id);
  }, [dismiss, items]);

  return {
    attached,
    uploads: items,
    busy: items.some((item) => item.status !== 'failed'),
    limitHit,
    add,
    retry: uploads.retry,
    cancel: uploads.cancel,
    remove: (key) => setAttached((list) => list.filter((entry) => entry.key !== key)),
    clear,
  };
}
