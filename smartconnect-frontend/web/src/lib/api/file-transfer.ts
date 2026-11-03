// File bytes cannot go through the JSON client: uploads need progress events (XMLHttpRequest) and downloads are
// binary. Both still authenticate like every other call (bearer token, one refresh-and-retry on 401).
import { defaultBaseUrl, type ApiClient } from './client';
import { ApiError } from './errors';
import type { StoredFile } from './types';

const contentUrl = (orgId: string, fileId: string) => `${defaultBaseUrl()}/orgs/${orgId}/files/${fileId}/content`;

function problemOf(text: string, status: number, requestId: string | null): ApiError {
  let problem: Record<string, unknown> = {};
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === 'object') problem = body as Record<string, unknown>;
  } catch {
    // Not JSON (proxy error page, empty body): the status alone describes it.
  }
  return new ApiError(status, problem, requestId ?? undefined);
}

interface XhrResult {
  status: number;
  text: string;
  requestId: string | null;
}

function putBytes(
  url: string,
  token: string | null,
  body: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () =>
      resolve({ status: xhr.status, text: xhr.responseText, requestId: xhr.getResponseHeader('X-Request-Id') });
    xhr.onerror = () => reject(new TypeError('network error'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.ontimeout = () => reject(new TypeError('network timeout'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/** Sends the bytes of a file declared with POST /orgs/{org}/files. `onProgress` receives 0..1. */
export async function uploadFileContent(
  api: ApiClient,
  orgId: string,
  fileId: string,
  body: Blob,
  { onProgress, signal }: { onProgress: (fraction: number) => void; signal?: AbortSignal },
): Promise<StoredFile> {
  const url = contentUrl(orgId, fileId);
  let result = await putBytes(url, api.getAccessToken(), body, onProgress, signal);
  if (result.status === 401 && (await api.refresh())) {
    onProgress(0);
    result = await putBytes(url, api.getAccessToken(), body, onProgress, signal);
  }
  if (result.status < 200 || result.status >= 300) throw problemOf(result.text, result.status, result.requestId);
  return JSON.parse(result.text) as StoredFile;
}

/** The bytes of a file, to show in a preview or save to disk. Only for files the person may read. */
export async function fetchFileContent(api: ApiClient, orgId: string, fileId: string, signal?: AbortSignal) {
  const send = (token: string | null) =>
    fetch(contentUrl(orgId, fileId), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal,
      credentials: 'same-origin',
    });
  let response = await send(api.getAccessToken());
  if (response.status === 401 && (await api.refresh())) response = await send(api.getAccessToken());
  if (!response.ok) {
    throw problemOf(await response.text(), response.status, response.headers.get('X-Request-Id'));
  }
  return response.blob();
}
