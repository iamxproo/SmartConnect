import type { ApiClient } from '@/lib/api/client';
import { fetchFileContent } from '@/lib/api/file-transfer';

/** What a search result needs to open a file: enough for the preview and the download. */
export interface OpenableFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/** Downloads through the authenticated client; the bytes are shown from a short-lived object URL. */
export async function downloadFile(api: ApiClient, orgId: string, file: OpenableFile): Promise<void> {
  const url = URL.createObjectURL(await fetchFileContent(api, orgId, file.id));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
