import { Logger } from '@nestjs/common';
import { BackgroundMailer, EmailDeliveryError, type EmailMessage } from '@smartconnect/backend-kit';
import { describe, expect, it, vi } from 'vitest';
import {
  notifySafely,
  SmtpInvitationNotifier,
  type InvitationMessage,
} from '../src/notifications/invitation-notifier.js';
import { cleanName, invitationEmail } from '../src/notifications/invitation-templates.js';

const TOKEN = 'Zq3x-raw-one-time-token_abcdefghijklmnopqrstu';
const message: InvitationMessage = {
  kind: 'organization_invitation',
  to: 'invitee@example.com',
  token: TOKEN,
  link: `https://app.example.com/invitations/accept#token=${TOKEN}`,
  organizationName: 'Acme Robotics',
  roleName: 'Member',
  invitedBy: 'Grace Hopper',
  expiresAt: new Date('2026-11-10T09:05:00Z'),
};

describe('invitationEmail', () => {
  it('names the organization, role, inviter and expiry, with an Accept button to the fragment link', () => {
    const { subject, html, text } = invitationEmail(message);
    expect(subject).toBe('Grace Hopper invited you to Acme Robotics on SmartConnect');
    expect(html).toContain(`<a href="${message.link}"`);
    expect(html).toContain('>Accept invitation</a>');
    for (const part of ['Acme Robotics', 'Role: Member', 'Invited by: Grace Hopper', '10 November 2026 at 09:05 UTC'])
      expect(html + text).toContain(part);
    expect(html).toContain('works only for the address it was sent to');
    expect(html).toContain('after you sign in');
    expect(html).toContain('someone invited you to join an organization');
    expect(text.split('\n')).toContain(message.link);
  });

  it('says "Someone" when the inviter is unknown', () => {
    expect(invitationEmail({ ...message, invitedBy: null }).subject).toBe(
      'Someone invited you to Acme Robotics on SmartConnect',
    );
    expect(invitationEmail({ ...message, invitedBy: '  \n ' }).subject).toMatch(/^Someone invited you/);
  });

  it('escapes hostile organization and inviter names and never links them', () => {
    const hostile = `<img src=x onerror=alert(1)> "Evil" & 'Co' https://evil.example/phish`;
    const { html, subject } = invitationEmail({ ...message, organizationName: hostile, invitedBy: hostile });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &quot;Evil&quot; &amp; &#39;Co&#39;');
    expect(html.match(/<a /g)).toHaveLength(1); // only the Accept button
    expect(html.match(/href="/g)).toHaveLength(1);
    expect(html).not.toContain('href="https://evil.example');
    expect(subject.length).toBeLessThanOrEqual(200);
  });

  it('strips control and direction-override characters from the subject and body', () => {
    const [nul, ls, rlo] = [0, 0x2028, 0x202e].map((code) => String.fromCharCode(code));
    const { subject, html, text } = invitationEmail({
      ...message,
      organizationName: `Acme\r\nBcc: evil@example.com${rlo}`,
      invitedBy: `Grace${nul}${ls}Hopper`,
      roleName: 'Mem\nber',
    });
    expect(subject).toBe('Grace Hopper invited you to Acme Bcc: evil@example.com on SmartConnect');
    // eslint-disable-next-line no-control-regex -- asserting that none survive
    const unsafe = new RegExp('[\\u0000-\\u0009\\u000b-\\u001f\\u2028-\\u202e]');
    expect(subject + html + text).not.toMatch(unsafe);
    expect(text).toContain('Role: Mem ber');
  });

  it('caps long names and the subject', () => {
    const long = 'x'.repeat(5000);
    const { subject } = invitationEmail({ ...message, organizationName: long, invitedBy: long });
    expect(subject.length).toBeLessThanOrEqual(200);
    expect(cleanName(long).length).toBe(80);
    expect(cleanName('  a \t b  ')).toBe('a b');
  });
});

describe('SmtpInvitationNotifier', () => {
  it('resolves at once even when the transport hangs, and queues the rendered email', async () => {
    const sent: EmailMessage[] = [];
    const transport = {
      send: (m: EmailMessage) => {
        sent.push(m);
        return new Promise<{ id: null }>(() => undefined);
      },
    };
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = new SmtpInvitationNotifier(new BackgroundMailer(transport, logger));
    const started = Date.now();
    await notifier.send(message);
    expect(Date.now() - started).toBeLessThan(100);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'invitee@example.com' });
    expect(sent[0]!.html).toContain(`href="https://app.example.com/invitations/accept#token=${TOKEN}"`);
    expect(sent[0]!.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('enqueues under the message kind and drains the mailer on shutdown', async () => {
    const enqueue = vi.fn<(kind: string, message: EmailMessage) => void>();
    const close = vi.fn().mockResolvedValue(undefined);
    const notifier = new SmtpInvitationNotifier({ enqueue, close });
    await notifier.send(message);
    expect(enqueue.mock.calls.map(([kind]) => kind)).toEqual(['organization_invitation']);
    await notifier.onApplicationShutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('notifySafely', () => {
  it('logs the error name and category, never its message', async () => {
    const logger = new Logger('test');
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await notifySafely({ send: () => Promise.reject(new Error(`550 invitee@example.com ${TOKEN}`)) }, logger, message);
    await notifySafely({ send: () => Promise.reject(new EmailDeliveryError('timeout', true)) }, logger, message);
    expect(error.mock.calls).toEqual([
      [{ event: 'invitation_notification_failed', kind: 'organization_invitation', error: 'Error' }],
      [
        {
          event: 'invitation_notification_failed',
          kind: 'organization_invitation',
          error: 'EmailDeliveryError:timeout',
        },
      ],
    ]);
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/invitee@|Zq3x/);
  });
});
