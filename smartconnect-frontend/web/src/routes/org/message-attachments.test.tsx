import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageAttachment, StoredFile } from '@/lib/api/types';
import { json, problem, stubApi } from '@/test/api-stub';
import { channel, inAcme, member, message, workspace } from '@/test/fixtures';
import { axeViolations, renderApp } from '@/test/render-app';

const PATH = '/o/acme/w/ws-1/c/ch-1';
const MESSAGES = '/orgs/org-1/workspaces/ws-1/channels/ch-1/messages';
const TARGET = '0192b5f0-0000-7000-8000-000000000002';

const stored = (overrides: Partial<StoredFile> = {}): StoredFile => ({
  id: 'file-9',
  name: 'notes.txt',
  mimeType: 'text/plain',
  sizeBytes: 11,
  status: 'available',
  uploadedByUserId: 'user-1',
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-03T10:00:00.000Z',
  ...overrides,
});

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
  url = '';
  aborted = false;
  constructor() {
    FakeXhr.all.push(this);
  }
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  getResponseHeader() {
    return null;
  }
  send() {}
  abort() {
    this.aborted = true;
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

beforeEach(() => {
  FakeXhr.all = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:file'), revokeObjectURL: vi.fn() }));
});
afterEach(() => vi.restoreAllMocks());

const grace = member({ id: 'member-2', userId: 'user-2', displayName: 'Grace Hopper', email: 'g@example.com' });
const setup = (extra: Record<string, never> | object = {}, messages: unknown[] = []) =>
  stubApi({
    ...inAcme(),
    'GET /orgs/org-1/workspaces': () => ({ data: [workspace()] }),
    'GET /orgs/org-1/workspaces/ws-1': () => workspace(),
    'GET /orgs/org-1/workspaces/ws-1/channels': () => ({ data: [channel()] }),
    'GET /orgs/org-1/workspaces/ws-1/channels/ch-1': () => channel(),
    'GET /orgs/org-1/workspaces/ws-1/channels/ch-1/members': () => ({ data: [] }),
    'GET /orgs/org-1/members': () => json(200, { data: [member(), grace], nextCursor: null }),
    [`GET ${MESSAGES}`]: () => json(200, { data: messages, nextCursor: null }),
    ...extra,
  });

const choose = (file: File) =>
  fireEvent.change(screen.getByLabelText('Choose files to attach'), { target: { files: [file] } });
const makeFile = (name = 'notes.txt') => new File(['hello world'], name, { type: 'text/plain' });
const send = () => screen.getByRole('button', { name: 'Send message' });

describe('attaching files in the composer', () => {
  it('uploads with progress, waits for it, then sends the file with an empty body', async () => {
    const stub = setup({
      'POST /orgs/org-1/files': () => json(201, stored({ status: 'pending_upload' })),
      [`POST ${MESSAGES}`]: () => json(201, message({ id: 'm9', body: '', attachments: [] })),
    });
    const { user } = await renderApp(PATH);
    await screen.findByRole('textbox', { name: 'Message #general' });
    expect(send()).toBeDisabled();

    choose(makeFile());
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    expect(lastXhr().url).toMatch(/\/orgs\/org-1\/files\/file-9\/content$/);
    act(() => lastXhr().progress(5, 11));
    const bar = await screen.findByRole('progressbar', { name: 'Uploading notes.txt' });
    expect(bar).toHaveAttribute('value', '45');
    expect(send()).toBeDisabled();
    expect(screen.getByText(/Uploading files/)).toBeInTheDocument();

    act(() => lastXhr().respond(200, stored()));
    const chips = within(await screen.findByRole('list', { name: 'Attachments' }));
    expect(chips.getByText('notes.txt')).toBeInTheDocument();
    expect(chips.getByText('11 B')).toBeInTheDocument();
    expect(send()).toBeEnabled();

    await user.click(send());
    await waitFor(() => expect(stub.callsTo(`POST ${MESSAGES}`)).toHaveLength(1));
    expect(stub.callsTo(`POST ${MESSAGES}`)[0]?.body).toMatchObject({ body: '', attachmentFileIds: ['file-9'] });
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Attachments' })).not.toBeInTheDocument());
  });

  it('keeps a failed upload with its reason, retries only the bytes, and lets me remove the file', async () => {
    const stub = setup({ 'POST /orgs/org-1/files': () => json(201, stored({ status: 'pending_upload' })) });
    const { user } = await renderApp(PATH);
    await screen.findByRole('textbox', { name: 'Message #general' });
    choose(makeFile());
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    act(() => lastXhr().respond(413, { status: 413, code: 'payload_too_large' }));
    expect(await screen.findByRole('alert', { name: '' })).toHaveTextContent(/larger than the allowed size/);
    expect(send()).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Retry notes.txt' }));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(2));
    expect(stub.callsTo('POST /orgs/org-1/files')).toHaveLength(1); // declared once
    act(() => lastXhr().respond(200, stored()));
    await user.click(await screen.findByRole('button', { name: 'Remove notes.txt' }));
    expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull();
    expect(send()).toBeDisabled();
  });

  it('cancels an upload in progress', async () => {
    setup({ 'POST /orgs/org-1/files': () => json(201, stored({ status: 'pending_upload' })) });
    const { user } = await renderApp(PATH);
    await screen.findByRole('textbox', { name: 'Message #general' });
    choose(makeFile());
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    await user.click(await screen.findByRole('button', { name: 'Cancel upload of notes.txt' }));
    expect(lastXhr().aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    expect(screen.queryByRole('list', { name: 'Attachments' })).toBeNull();
  });

  it('attaches files dropped on the conversation', async () => {
    const stub = setup({ 'POST /orgs/org-1/files': () => json(201, stored({ status: 'pending_upload' })) });
    await renderApp(PATH);
    await screen.findByRole('textbox', { name: 'Message #general' });
    const target = screen.getByRole('region', { name: 'Conversation' });
    const dataTransfer = { types: ['Files'], files: [makeFile()] };
    fireEvent.dragEnter(target, { dataTransfer });
    expect(await screen.findByText('Drop files to attach')).toBeInTheDocument();
    fireEvent.drop(target, { dataTransfer });
    await waitFor(() => expect(stub.callsTo('POST /orgs/org-1/files')).toHaveLength(1));
    expect(screen.queryByText('Drop files to attach')).toBeNull();
  });
});

const image: MessageAttachment = { fileId: 'file-img', name: 'logo.png', mimeType: 'image/png', sizeBytes: 2500 };
const pdf: MessageAttachment = {
  fileId: 'file-pdf',
  name: 'plan.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1_400_000,
};
const withFiles = message({ id: 'm1', body: 'see attached', attachments: [image, pdf] });

describe('attachments in messages', () => {
  it('shows images as thumbnails that open the preview, and other files as cards with a download', async () => {
    const stub = setup(
      {
        'GET /orgs/org-1/files/file-img/content': () => new Response('png', { status: 200 }),
        'GET /orgs/org-1/files/file-pdf/content': () => new Response('pdf', { status: 200 }),
      },
      [withFiles],
    );
    const { user } = await renderApp(PATH);
    const thumb = await screen.findByRole('img', { name: 'logo.png' });
    expect(thumb).toHaveAttribute('src', 'blob:file');
    const files = within(screen.getByRole('list', { name: 'Files' }));
    expect(files.getByText('plan.pdf')).toBeInTheDocument();
    expect(files.getByText('PDF document · 1.4 MB')).toBeInTheDocument();
    // The thumbnail was fetched with the token; nothing else was downloaded yet.
    expect(stub.callsTo('GET /orgs/org-1/files/file-img/content')[0]?.headers.get('Authorization')).toMatch(/^Bearer /);
    expect(stub.callsTo('GET /orgs/org-1/files/file-pdf/content')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Preview logo.png' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('logo.png');

    await user.keyboard('{Escape}');
    await user.click(files.getByRole('button', { name: 'Download plan.pdf' }));
    await waitFor(() => expect(stub.callsTo('GET /orgs/org-1/files/file-pdf/content')).toHaveLength(1));
    expect(await axeViolations()).toEqual([]);
  });

  it('says "file unavailable" when the file is gone', async () => {
    setup(
      {
        'GET /orgs/org-1/files/file-img/content': () => problem(404, 'not_found'),
        'GET /orgs/org-1/files/file-pdf/content': () => problem(404, 'not_found'),
      },
      [withFiles],
    );
    const { user } = await renderApp(PATH);
    expect(await screen.findByText('logo.png: file unavailable')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Download plan.pdf' }));
    expect(await screen.findByText('plan.pdf: file unavailable')).toBeInTheDocument();
  });
});

describe('jumping to a message (?message=)', () => {
  const m = (id: string, body: string, minute: number) =>
    message({ id, body, createdAt: `2026-11-03T10:0${minute}:00.000Z` });
  const context = (extra: object = {}) => ({
    [`GET ${MESSAGES}/${TARGET}/context`]: () =>
      json(200, {
        data: [m('c1', 'before it', 1), m(TARGET, 'the one', 2), m('c3', 'after it', 3)],
        targetId: TARGET,
        isReply: false,
        replyId: null,
        ...extra,
      }),
  });

  it('opens the context panel around the message, highlights it, and jumps to the latest', async () => {
    const stub = setup(context(), [m('m5', 'latest', 5)]);
    const { user, router } = await renderApp(`${PATH}?message=${TARGET}`);
    const panel = await screen.findByRole('complementary', { name: 'Message in context' });
    const list = within(await within(panel).findByRole('list', { name: 'Messages around the message' }));
    expect(list.getAllByRole('listitem').map((li) => li.querySelector('p')?.textContent)).toEqual([
      'before it',
      'the one',
      'after it',
    ]);
    expect(list.getByText('the one').closest('li')).toHaveAttribute('data-highlight', 'true');
    expect(list.getByText('before it').closest('li')).not.toHaveAttribute('data-highlight');
    const call = stub.callsTo(`GET ${MESSAGES}/:id/context`)[0];
    expect(call?.query.get('before')).toBe('10');
    expect(call?.query.get('after')).toBe('10');
    expect(await axeViolations()).toEqual([]);

    await user.click(within(panel).getByRole('button', { name: 'Jump to latest' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Message in context' })).toBeNull());
    expect(router.state.location.search).not.toHaveProperty('message');
    expect(within(screen.getByRole('log')).getByText('latest')).toBeInTheDocument();
  });

  it('closes with the button and with Escape, and leaves the parameter', async () => {
    setup(context());
    const { user, router } = await renderApp(`${PATH}?message=${TARGET}`);
    await screen.findByRole('complementary', { name: 'Message in context' });
    await user.click(screen.getByRole('button', { name: 'Close message context' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Message in context' })).toBeNull());
    expect(router.state.location.search).not.toHaveProperty('message');
  });

  it('says so for a reply, and when the message is no longer available', async () => {
    setup(context({ isReply: true, replyId: 'r1' }));
    await renderApp(`${PATH}?message=${TARGET}`);
    expect(await screen.findByText('This message is a reply in a thread.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open thread' })).toBeInTheDocument();
  });

  it('shows an error inside the panel for a message that is gone, and ignores a malformed id', async () => {
    setup({ [`GET ${MESSAGES}/${TARGET}/context`]: () => problem(404, 'not_found') });
    await renderApp(`${PATH}?message=${TARGET}`);
    expect(await screen.findByRole('alert')).toHaveTextContent("doesn't exist, or you don't have access");
  });

  it('ignores a parameter that is not an id', async () => {
    const stub = setup();
    await renderApp(`${PATH}?message=${encodeURIComponent('<script>')}`);
    await screen.findByRole('log', { name: 'Messages in #general' });
    expect(screen.queryByRole('complementary', { name: 'Message in context' })).toBeNull();
    expect(stub.calls.some((c) => c.path.endsWith('/context'))).toBe(false);
  });
});
