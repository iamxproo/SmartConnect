// A minimal ESMTP server on 127.0.0.1 for tests: 220 greeting, EHLO (AUTH PLAIN LOGIN, no STARTTLS), AUTH, MAIL, RCPT,
// DATA with the "." terminator, RSET, NOOP, QUIT. Replies are programmable; it records what it was given. Nothing
// here ever leaves the machine.
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface SmtpScript {
  /** Greeting line; `null` = never greet (a hung server). */
  greeting?: string | null;
  auth?: string;
  mailFrom?: string;
  rcptTo?: string;
  /** Reply to the DATA command itself (default 354). */
  data?: string;
  /** Reply once the "." terminator arrived (default 250). */
  end?: string;
  /** Close the socket right after the "." terminator, without replying. */
  dropAfterData?: boolean;
}

export interface Received {
  commands: string[];
  authAttempts: { user: string; pass: string }[];
  envelope: { from?: string; to: string[] };
  /** The DATA payload of the last message. */
  data: string;
  messages: number;
}

export class FakeSmtpServer {
  script: SmtpScript = {};
  received: Received = emptyReceived();
  private server!: Server;
  private readonly sockets = new Set<Socket>();
  port = 0;

  async start(): Promise<this> {
    this.server = createServer((socket) => this.handle(socket));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  reset(script: SmtpScript = {}): void {
    this.script = script;
    this.received = emptyReceived();
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    const say = (line: string) => socket.write(`${line}\r\n`);
    const { greeting } = this.script;
    if (greeting !== null) say(greeting ?? '220 fake.test ESMTP ready');

    let buffer = '';
    let inData = false;
    let data = '';
    let loginStep: 'user' | 'pass' | undefined;
    let loginUser = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          this.received.data = data;
          this.received.messages++;
          if (this.script.dropAfterData) return socket.destroy();
          say(this.script.end ?? '250 2.0.0 queued as FAKE1');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const [verb = ''] = line.split(' ');
        const upper = verb.toUpperCase();

        if (loginStep === 'user') {
          loginUser = Buffer.from(line, 'base64').toString();
          loginStep = 'pass';
          say('334 UGFzc3dvcmQ6');
          continue;
        }
        if (loginStep === 'pass') {
          loginStep = undefined;
          this.received.authAttempts.push({ user: loginUser, pass: Buffer.from(line, 'base64').toString() });
          say(this.script.auth ?? '235 2.7.0 Accepted');
          continue;
        }
        this.received.commands.push(upper);
        switch (upper) {
          case 'EHLO':
            socket.write('250-fake.test greets you\r\n250-8BITMIME\r\n250 AUTH PLAIN LOGIN\r\n');
            break;
          case 'AUTH': {
            const [, mechanism, initial] = line.split(' ');
            if (mechanism?.toUpperCase() === 'PLAIN' && initial) {
              const [, user = '', pass = ''] = Buffer.from(initial, 'base64').toString().split('\0');
              this.received.authAttempts.push({ user, pass });
              say(this.script.auth ?? '235 2.7.0 Accepted');
            } else {
              loginStep = 'user';
              say('334 VXNlcm5hbWU6');
            }
            break;
          }
          case 'MAIL':
            this.received.envelope = { from: /<([^>]*)>/.exec(line)?.[1], to: [] };
            say(this.script.mailFrom ?? '250 2.1.0 OK');
            break;
          case 'RCPT': {
            const reply = this.script.rcptTo ?? '250 2.1.5 OK';
            if (reply.startsWith('2')) this.received.envelope.to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
            say(reply);
            break;
          }
          case 'DATA': {
            const reply = this.script.data ?? '354 End data with <CR><LF>.<CR><LF>';
            say(reply);
            if (reply.startsWith('3')) {
              inData = true;
              data = '';
            }
            break;
          }
          case 'QUIT':
            say('221 2.0.0 Bye');
            socket.end();
            break;
          default:
            say('250 2.0.0 OK');
        }
      }
    });
  }
}

const emptyReceived = (): Received => ({
  commands: [],
  authAttempts: [],
  envelope: { to: [] },
  data: '',
  messages: 0,
});

/** The DATA payload with MIME quoted-printable soft line breaks and escapes undone, for substring assertions. */
export function decodeQuotedPrintable(data: string): string {
  return data
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
