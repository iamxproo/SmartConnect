// An EmailTransport that keeps what it is given and never touches a network: for integration suites that run the real
// SMTP notifier and BackgroundMailer end to end.
import type { EmailMessage, EmailTransport } from '@smartconnect/backend-kit';

export class CapturingTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];
  /** Held before each send resolves: simulates a slow mail server. */
  delayMs = 0;
  /** When set, every send rejects with this. */
  failWith?: Error;
  closed = false;

  async send(message: EmailMessage): Promise<{ id: string | null }> {
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.failWith) throw this.failWith;
    this.sent.push(message);
    return { id: `<${this.sent.length}@capture.test>` };
  }

  close(): void {
    this.closed = true;
  }

  to(address: string): EmailMessage[] {
    return this.sent.filter((m) => m.to.toLowerCase() === address.toLowerCase());
  }

  /** Waits until `count` messages went to `address`, then returns them, oldest first. */
  async waitFor(address: string, count = 1, timeoutMs = 5000): Promise<EmailMessage[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.to(address).length < count) {
      if (Date.now() > deadline)
        throw new Error(`no email arrived (${count} expected, ${this.to(address).length} sent)`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.to(address);
  }
}

/** The one-time token in the email's link: from the plain-text part, where the URL stands alone on a line. */
export function tokenOf(message: EmailMessage): string {
  const match = /#token=([A-Za-z0-9_-]{43})\s*$/m.exec(message.text);
  if (!match) throw new Error('no token link in the email');
  return match[1]!;
}

/** The link in the HTML button must be the same one. */
export function htmlLinkOf(message: EmailMessage): string | undefined {
  return /<a href="([^"]+)"/.exec(message.html)?.[1]?.replaceAll('&amp;', '&');
}
