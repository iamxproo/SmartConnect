import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { uploadFileContent } from '@/lib/api/file-transfer';
import { describeError } from '@/lib/api/messages';
import type { StoredFile } from '@/lib/api/types';
import { filesKey } from '@/lib/queries/files';
import { useApi } from '@/lib/services';

export interface UploadItem {
  id: number;
  file: File;
  /** Set once the server has accepted the declaration; a retry then re-sends only the bytes. */
  fileId?: string;
  status: 'queued' | 'uploading' | 'failed';
  /** 0..1 */
  progress: number;
  error?: string;
  retryable: boolean;
}

const MESSAGES = {
  too_large: 'This file is larger than the allowed size.',
  size_mismatch: 'The file changed while uploading. Try again.',
  payload_too_large: 'This file is larger than the allowed size.',
  already_uploaded: 'This file was already uploaded.',
  upload_interrupted: 'The upload was interrupted. Try again.',
};

const nextQueued = (items: UploadItem[]) => items.find((item) => item.status === 'queued');

/** Uploads one file at a time (declare, then send the bytes with progress), keeping failures for retry. */
export function useUploads(orgId: string, onUploaded?: (item: UploadItem, file: StoredFile) => void) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [items, setItems] = useState<UploadItem[]>([]);
  // The list lives in a ref as well, so the queue can be advanced from event handlers and upload completions
  // without an effect (state is only a rendering mirror of it).
  const list = useRef<UploadItem[]>([]);
  const busy = useRef(false);
  const nextId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const current = useRef<number | null>(null);
  const cancelled = useRef(new Set<number>());
  const uploaded = useRef(onUploaded);
  useEffect(() => {
    uploaded.current = onUploaded;
  });

  const commit = useCallback((update: (current: UploadItem[]) => UploadItem[]) => {
    list.current = update(list.current);
    setItems(list.current);
  }, []);
  const patch = useCallback(
    (id: number, changes: Partial<UploadItem>) =>
      commit((current) => current.map((item) => (item.id === id ? { ...item, ...changes } : item))),
    [commit],
  );

  /** Sends one queued item; resolves false when the page went away and the queue must stop. */
  const send = useCallback(
    async (item: UploadItem): Promise<boolean> => {
      patch(item.id, { status: 'uploading', progress: 0, error: undefined });
      const abort = new AbortController();
      controller.current = abort;
      current.current = item.id;
      let stored: StoredFile;
      try {
        let fileId = item.fileId;
        if (!fileId) {
          const created = await api.post<StoredFile>(`/orgs/${orgId}/files`, {
            name: item.file.name,
            sizeBytes: item.file.size,
          });
          fileId = created.id;
          patch(item.id, { fileId });
        }
        stored = await uploadFileContent(api, orgId, fileId, item.file, {
          signal: abort.signal,
          onProgress: (progress) => patch(item.id, { progress }),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // Cancelled by the person: carry on with the rest. Otherwise the page went away.
          if (!cancelled.current.delete(item.id)) return false;
          commit((entries) => entries.filter((entry) => entry.id !== item.id));
          return true;
        }
        patch(item.id, { status: 'failed', error: describeError(error, MESSAGES) });
        return true;
      }
      uploaded.current?.(item, stored);
      commit((entries) => entries.filter((entry) => entry.id !== item.id));
      await queryClient.invalidateQueries({ queryKey: filesKey(orgId) });
      return true;
    },
    [api, commit, orgId, patch, queryClient],
  );

  const pump = useCallback(async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    try {
      for (let item = nextQueued(list.current); item; item = nextQueued(list.current)) {
        if (!(await send(item))) break;
      }
    } finally {
      busy.current = false;
    }
  }, [send]);

  useEffect(() => () => controller.current?.abort(), []);

  const add = useCallback(
    (files: File[]) => {
      commit((current) => [
        ...current,
        ...files.map<UploadItem>((file) => {
          const id = nextId.current++;
          return file.size === 0
            ? { id, file, status: 'failed', progress: 0, retryable: false, error: "Empty files can't be uploaded." }
            : { id, file, status: 'queued', progress: 0, retryable: true };
        }),
      ]);
      void pump();
    },
    [commit, pump],
  );
  const retry = useCallback(
    (id: number) => {
      patch(id, { status: 'queued', error: undefined, progress: 0 });
      void pump();
    },
    [patch, pump],
  );
  const dismiss = useCallback((id: number) => commit((entries) => entries.filter((item) => item.id !== id)), [commit]);
  /** Stops an upload in progress (the rest of the queue goes on) or removes a waiting one. */
  const cancel = useCallback(
    (id: number) => {
      if (current.current === id && list.current.some((item) => item.id === id && item.status === 'uploading')) {
        cancelled.current.add(id);
        controller.current?.abort();
      } else dismiss(id);
    },
    [dismiss],
  );

  return { items, add, retry, dismiss, cancel };
}
