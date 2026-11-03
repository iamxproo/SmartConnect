// People and organizations for browser tests. Everyone gets their own browser context and client address
// (X-Forwarded-For, trusted by the test gateway only), so sessions and per-IP rate limits never mix. Setup that a
// test is not about (registering, verifying, creating an org, inviting) goes through the same public API the web app
// uses; the flows under test go through the UI.
import { randomUUID } from 'node:crypto';
import { appendFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  test as base,
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

export const PASSWORD = 'correct horse battery staple 42';

export interface Person {
  name: string;
  email: string;
  userId: string;
  context: BrowserContext;
  page: Page;
  /** Bearer token for setup calls through the gateway (never used by the page itself). */
  token: string;
  api: APIRequestContext;
}

export interface Org {
  id: string;
  slug: string;
  name: string;
  roles: { owner: string; admin: string; member: string };
}

let address = 0;
const nextAddress = () => {
  address += 1;
  return `198.51.100.${(address % 250) + 1}`; // TEST-NET-2
};

async function mailboxToken(serviceUrl: string, to: string, kind?: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await fetch(`${serviceUrl}/dev/mailbox?to=${encodeURIComponent(to)}`);
    const { data } = (await res.json()) as { data: { kind?: string; token?: string; link?: string }[] };
    const message = data.find((m) => (kind ? m.kind === kind : true) && (m.token ?? m.link));
    const token = message?.token ?? (message?.link ? new URL(message.link).hash.replace(/^#token=/, '') : undefined);
    if (token) return decodeURIComponent(token);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no mailbox message for ${to}`);
}

export const verificationToken = (email: string) =>
  mailboxToken(process.env.E2E_IDENTITY_URL!, email, 'email_verification');
export const invitationToken = (email: string) => mailboxToken(process.env.E2E_ORGANIZATION_URL!, email);

export async function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': nextAddress() } });
}

async function json<T>(res: Awaited<ReturnType<APIRequestContext['get']>>, status: number): Promise<T> {
  if (res.status() !== status) throw new Error(`${res.url()} answered ${res.status()}: ${await res.text()}`);
  return (res.status() === 204 ? undefined : await res.json()) as T;
}

/** Registers, verifies the email and signs in through the API (the refresh cookie lands in the context). */
export async function person(
  browser: Browser,
  name: string,
  email = `${name.toLowerCase()}-${randomUUID()}@example.com`,
): Promise<Person> {
  const context = await newContext(browser);
  const api = context.request;
  await json(await api.post('/api/v1/auth/register', { data: { email, password: PASSWORD, displayName: name } }), 202);
  await json(await api.post('/api/v1/auth/email/verify', { data: { token: await verificationToken(email) } }), 204);
  const { accessToken } = await json<{ accessToken: string }>(
    await api.post('/api/v1/auth/login', { data: { email, password: PASSWORD } }),
    200,
  );
  const me = await json<{ id: string }>(
    await api.get('/api/v1/auth/me', { headers: { Authorization: `Bearer ${accessToken}` } }),
    200,
  );
  return { name, email, userId: me.id, context, page: await context.newPage(), token: accessToken, api };
}

/** The next unused organization creator. The cursor is a file, so a worker restarted after a failure never reuses one. */
export const founderEmail = () => {
  const founders = process.env.E2E_FOUNDERS!.split(',');
  const cursor = path.join(process.env.E2E_LOG_DIR!, `${founders[0]}.cursor`);
  appendFileSync(cursor, '.');
  const email = founders[(statSync(cursor).size - 1) % founders.length]!;
  return email;
};

export async function call<T = unknown>(
  who: Person,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  path: string,
  data?: unknown,
  status = method === 'post' ? 201 : method === 'delete' ? 204 : 200,
): Promise<T> {
  const res = await who.api[method](`/api/v1${path}`, {
    headers: { Authorization: `Bearer ${who.token}` },
    ...(data === undefined ? {} : { data }),
  });
  return json<T>(res, status);
}

export async function createOrg(founder: Person, name = `Acme ${randomUUID().slice(0, 6)}`): Promise<Org> {
  const slug = `acme-${randomUUID().slice(0, 8)}`;
  const org = await call<{ id: string; slug: string; name: string }>(founder, 'post', '/orgs', { name, slug });
  const { data } = await call<{ data: { id: string; key: string }[] }>(founder, 'get', `/orgs/${org.id}/roles`);
  const role = (key: string) => data.find((r) => r.key === key)!.id;
  return { ...org, roles: { owner: role('owner'), admin: role('admin'), member: role('member') } };
}

/** Invites `who` and accepts through the API. */
export async function join(org: Org, inviter: Person, who: Person, role: keyof Org['roles'] = 'member'): Promise<void> {
  await call(inviter, 'post', `/orgs/${org.id}/invitations`, { email: who.email, roleId: org.roles[role] });
  await call(who, 'post', '/invitations/accept', { token: await invitationToken(who.email) }, 200);
}

export interface Workspace {
  id: string;
  name: string;
  /** The public channel every workspace starts with. */
  generalId: string;
}

/** Creates a workspace through the API (`owner` becomes its administrator). */
export async function createWorkspace(
  owner: Person,
  org: Org,
  name = `Ops ${randomUUID().slice(0, 6)}`,
  visibility: 'open' | 'private' = 'open',
): Promise<Workspace> {
  const slug = `ws-${randomUUID().slice(0, 8)}`;
  const { id } = await call<{ id: string }>(owner, 'post', `/orgs/${org.id}/workspaces`, { name, slug, visibility });
  const { data } = await call<{ data: { id: string; name: string }[] }>(
    owner,
    'get',
    `/orgs/${org.id}/workspaces/${id}/channels`,
  );
  return { id, name, generalId: data.find((channel) => channel.name === 'general')!.id };
}

/** `who` joins an open workspace through the API (and with it the default channels). */
export const joinWorkspace = (who: Person, org: Org, workspace: Workspace) =>
  call(who, 'post', `/orgs/${org.id}/workspaces/${workspace.id}/join`, undefined, 200);

/** A founder with a fresh organization, plus one member per name who has joined it through the API. */
export async function orgOf(browser: Browser, founderName: string, ...memberNames: string[]) {
  const owner = await person(browser, founderName, founderEmail());
  const org = await createOrg(owner);
  const members: Person[] = [];
  for (const name of memberNames) {
    const member = await person(browser, name);
    await join(org, owner, member);
    members.push(member);
  }
  return { owner, org, members };
}

export const test = base;
export { expect };
