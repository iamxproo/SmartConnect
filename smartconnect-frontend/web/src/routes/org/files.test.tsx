import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredFile } from '@/lib/api/types';
import { json, problem, stubApi } from '@/test/api-stub';
import { inAcme, page } from '@/test/fixtures';
import { axeViolations, renderApp } from '@/test/render-app';

const stored = (overrides: Partial<StoredFile> = {}): StoredFile => ({
  id: 'file-1',
  name: 'logo.png',
  mimeType: 'image/png',
  sizeBytes: 2_500,
  status: 'available',
  uploadedByUserId: 'user-1',
  createdAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});
const report = stored({ id: 'file-2', name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 1_400_000 });

/** XMLHttpRequest double: the test drives progress and the outcome. */
class FakeXhr {
  static all: FakeXhr[] = [];
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 0;
  responseText = '';
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: unknown;
  constructor() {
    FakeXhr.all.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  getResponseHeader() {
    return null;
  }
  send(body: unknown) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}
const lastXhr = () => FakeXhr.all[FakeXhr.all.length - 1]!;

let createObjectURL = vi.fn<(blob: Blob) => string>();
let revokeObjectURL = vi.fn<(url: string) => void>();

beforeEach(() => {
  FakeXhr.all = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  createObjectURL = vi.fn(() => 'blob:preview');
  revokeObjectURL = vi.fn();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }));
});
afterEach(() => vi.restoreAllMocks());

const picker = () => screen.getByLabelText('Choose files to upload');
const makeFile = (name = 'notes.txt', content = 'hello world') => new File([content], name, { type: 'text/plain' });

describe('files page', () => {
  it('lists my files with type, size and date, and says so when there are none', async () => {
    stubApi({ ...inAcme(), 'GET /orgs/org-1/files': () => page([stored(), report]) });
    await renderApp('/o/acme/files');
    const list = within(await screen.findByRole('list', { name: 'Your files' }));
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(list.getByText(/PNG image · 2\.5 KB · /)).toBeInTheDocument();
    expect(list.getByText(/PDF document · 1\.4 MB · /)).toBeInTheDocument();
    expect(list.getByRole('button', { name: 'Preview logo.png' })).toBeInTheDocument();
    expect(list.queryByRole('button', { name: 'Preview report.pdf' })).not.toBeInTheDocument(); // PDFs are downloads
  });

  it('shows an empty state, a loading failure with retry, and a Files link in the sidebar', async () => {
    let fail = true;
    stubApi({
      ...inAcme(),
      'GET /orgs/org-1/files': () => (fail ? problem(500, 'internal_error') : page([])),
    });
    const { user } = await renderApp('/o/acme/files');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load files");
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No files yet')).toBeInTheDocument();
    const nav = within(screen.getAllByRole('navigation', { name: 'Primary' })[0]!);
    expect(nav.getByRole('link', { name: 'Files' })).toBeInTheDocument();
  });

  it('uploads a chosen file: declares it, shows progress, then lists it', async () => {
    let uploaded = false;
    const stub = stubApi({
      ...inAcme(),
      'GET /orgs/org-1/files': () =>
        page(uploaded ? [stored({ id: 'file-9', name: 'notes.txt', mimeType: 'text/plain' })] : []),
      'POST /orgs/org-1/files': () => json(201, stored({ id: 'file-9', name: 'notes.txt', status: 'pending_upload' })),
    });
    const { user } = await renderApp('/o/acme/files');
    await screen.findByText('No files yet');
    await user.upload(picker(), makeFile());

    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    expect(stub.callsTo('POST /orgs/org-1/files')[0]?.body).toEqual({ name: 'notes.txt', sizeBytes: 11 });
    const xhr = lastXhr();
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toMatch(/\/orgs\/org-1\/files\/file-9\/content$/);
    expect(xhr.headers['Content-Type']).toBe('application/octet-stream');
    expect((xhr.body as File).name).toBe('notes.txt');

    xhr.progress(5, 11);
    const bar = await screen.findByRole('progressbar', { name: 'Uploading notes.txt' });
    expect(bar).toHaveAttribute('value', '45');
    expect(screen.getByText('45% of 11 B')).toBeInTheDocument();

    uploaded = true;
    xhr.respond(200, stored({ id: 'file-9', name: 'notes.txt', mimeType: 'text/plain' }));
    expect(
      await within(await screen.findByRole('list', { name: 'Your files' })).findByText('notes.txt'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('keeps a failed upload with the reason, and retries only the bytes', async () => {
    const stub = stubApi({
      ...inAcme(),
      'GET /orgs/org-1/files': () => page([]),
      'POST /orgs/org-1/files': () => json(201, stored({ id: 'file-9', name: 'notes.txt', status: 'pending_upload' })),
    });
    const { user } = await renderApp('/o/acme/files');
    await screen.findByText('No files yet');
    await user.upload(picker(), makeFile());
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    lastXhr().respond(413, { status: 413, code: 'payload_too_large' });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Upload failed. This file is larger than the allowed size.',
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(2));
    expect(lastXhr().url).toMatch(/file-9\/content$/);
    expect(stub.callsTo('POST /orgs/org-1/files')).toHaveLength(1); // not declared twice
    lastXhr().respond(200, stored({ id: 'file-9', name: 'notes.txt' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('reports a network failure and lets the person dismiss the upload', async () => {
    stubApi({
      ...inAcme(),
      'GET /orgs/org-1/files': () => page([]),
      'POST /orgs/org-1/files': () => json(201, stored({ id: 'file-9', status: 'pending_upload' })),
    });
    const { user } = await renderApp('/o/acme/files');
    await screen.findByText('No files yet');
    await user.upload(picker(), makeFile());
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    lastXhr().onerror?.();
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach SmartConnect");
    await user.click(screen.getByRole('button', { name: 'Dismiss notes.txt' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the server reason when the declaration is refused', async () => {
    stubApi({
      ...inAcme(),
      'GET /orgs/org-1/files': () => page([]),
      'POST /orgs/org-1/files': () => problem(422, 'validation_failed'),
    });
    const { user } = await renderApp('/o/acme/files');
    await screen.findByText('No files yet');
    await user.upload(picker(), makeFile());
    expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed. Server says validation_failed');
    expect(FakeXhr.all).toHaveLength(0);
  });

  it("refuses empty files without calling the network and can't retry them", async () => {
    const stub = stubApi({ ...inAcme(), 'GET /orgs/org-1/files': () => page([]) });
    const { user } = await renderApp('/o/acme/files');
    await screen.findByText('No files yet');
    await user.upload(picker(), makeFile('empty.txt', ''));
    expect(await screen.findByRole('alert')).toHaveTextContent("Empty files can't be uploaded.");
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(stub.callsTo('POST /orgs/org-1/files')).toHaveLength(0);
  });

  it('accepts files dropped on the upload area, one upload at a time', async () => {
    const stub = stubApi({
      ...inAcme(),
      'GET /orgs/org-1/files': () => page([]),
      'POST /orgs/org-1/files': (call) =>
        json(201, stored({ id: `id-${(call.body as { name: string }).name}`, status: 'pending_upload' })),
    });
    await renderApp('/o/acme/files');
    await screen.findByText('No files yet');
    const zone = screen.getByRole('group', { name: 'Upload files' });
    fireEvent.dragEnter(zone, { dataTransfer: { types: ['Files'], files: [] } });
    expect(screen.getByText('Drop to upload')).toBeInTheDocument();
    fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [makeFile('a.txt'), makeFile('b.txt')] } });

    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    expect(stub.callsTo('POST /orgs/org-1/files')).toHaveLength(1); // the second waits
    expect(await screen.findByText('Waiting…')).toBeInTheDocument();
    lastXhr().respond(200, stored({ id: 'id-a.txt', name: 'a.txt' }));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(2));
    expect(lastXhr().url).toMatch(/id-b\.txt\/content$/);
    expect(screen.queryByText('Drop to upload')).not.toBeInTheDocument();
  });

  it('deletes a file after confirmation', async () => {
    let remaining = [stored(), report];
    const stub = stubApi({
      ...inAcme(),
      'GET /orgs/org-1/files': () => page(remaining),
      'DELETE /orgs/org-1/files/:id': (_call, params) => {
        remaining = remaining.filter((file) => file.id !== params.id);
        return undefined;
      },
    });
    const { user } = await renderApp('/o/acme/files');
    await user.click(await screen.findByRole('button', { name: 'Delete report.pdf' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete file' }));
    await waitFor(() => expect(stub.callsTo('DELETE /orgs/org-1/files/file-2')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('report.pdf')).not.toBeInTheDocument());
    expect(screen.getByText('logo.png')).toBeInTheDocument();
  });

  it('previews an image from its bytes, and shows a failure with retry', async () => {
    let fail = true;
    const stub = stubApi({
      ...inAcme(),
      'GET /orgs/org-1/files': () => page([stored()]),
      'GET /orgs/org-1/files/:id/content': () =>
        fail
          ? problem(404, 'not_found')
          : new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
    });
    const { user } = await renderApp('/o/acme/files');
    await user.click(await screen.findByRole('button', { name: 'Preview logo.png' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent("Couldn't load the preview");
    fail = false;
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    const image = await within(dialog).findByRole('img', { name: 'logo.png' });
    expect(image).toHaveAttribute('src', 'blob:preview');
    expect(stub.callsTo('GET /orgs/org-1/files/file-1/content')).toHaveLength(2);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  it('downloads a file through an authenticated request, and reports a failure', async () => {
    let fail = false;
    stubApi({
      ...inAcme(),
      'GET /orgs/org-1/files': () => page([report]),
      'GET /orgs/org-1/files/:id/content': () =>
        fail ? problem(503, 'dependency_unavailable') : new Response('%PDF-1.7'),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const { user } = await renderApp('/o/acme/files');
    await user.click(await screen.findByRole('button', { name: 'Download report.pdf' }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(createObjectURL).toHaveBeenCalled();

    fail = true;
    await user.click(screen.getByRole('button', { name: 'Download report.pdf' }));
    expect(await screen.findByText("Couldn't download report.pdf")).toBeInTheDocument();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('has no axe accessibility violations with files and an upload in progress', async () => {
    stubApi({
      ...inAcme(),
      'GET /orgs/org-1/files': () => page([stored(), report]),
      'POST /orgs/org-1/files': () => json(201, stored({ id: 'file-9', status: 'pending_upload' })),
    });
    const { user } = await renderApp('/o/acme/files');
    await screen.findByRole('list', { name: 'Your files' });
    await user.upload(picker(), makeFile());
    await screen.findByRole('progressbar');
    expect(await axeViolations()).toEqual([]);
  });
});
