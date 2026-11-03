// Local SMTP checks for SmartConnect (ADR 0014), using the settings `make smtp-credentials` wrote to the gitignored
// .secrets/smtp.env (loaded into this process only).
//   node infrastructure/scripts/smtp.mjs check          verifies the connection and login; sends nothing
//   node infrastructure/scripts/smtp.mjs send <address>  sends ONE test email to the address given, and nowhere else
// Prints neither the password, nor the server's reply text, nor the email's content: only a category and SMTP code.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SETTINGS = path.join(REPO, '.secrets/smtp.env');
const kit = await import(
  pathToFileURL(path.join(REPO, 'smartconnect-backend/packages/backend-kit/dist/index.js')).href
);

const [command, to] = process.argv.slice(2);
if (command !== 'check' && command !== 'send') {
  console.error('Usage: make smtp-check | make smtp-test-email TO=someone@example.com');
  process.exit(2);
}
if (command === 'send' && !(to && kit.isEmailAddress(to))) {
  console.error('Give exactly one recipient you chose: make smtp-test-email TO=someone@example.com');
  process.exit(2);
}
if (!existsSync(SETTINGS)) {
  console.error('No .secrets/smtp.env yet: run make smtp-credentials in your own terminal first.');
  process.exit(1);
}
process.loadEnvFile(SETTINGS);

const problems = [];
const config = kit.parseSmtpConfig(process.env, problems);
if (problems.length > 0) {
  console.error(`The SMTP settings are incomplete:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

const transport = new kit.SmtpTransport(config);
const server = `${config.host}:${config.port} (${config.secure ? 'TLS' : 'STARTTLS required'}) as ${config.user}`;
try {
  if (command === 'check') {
    await transport.verify();
    console.log(`SMTP login OK: ${server}. No email was sent.`);
  } else {
    const email = kit.renderEmail({
      subject: 'SmartConnect test email',
      preheader: 'Email delivery from SmartConnect works.',
      heading: 'Email delivery works',
      paragraphs: [
        'This is a test email sent from SmartConnect’s local setup (make smtp-test-email).',
        'No action is needed. If you did not expect it, you can ignore it.',
      ],
      footer: 'account',
    });
    const { id } = await transport.send({ to, ...email, idempotencyKey: randomUUID() });
    console.log(`Accepted by ${config.host} for delivery (message id ${id ?? 'not reported'}).`);
    console.log('Acceptance is not delivery: check that inbox, including spam, to confirm it arrived.');
  }
} catch (error) {
  const known = error instanceof kit.EmailDeliveryError;
  const detail = known
    ? `${error.category}${error.status ? `, SMTP ${error.status}` : ''}${error.providerCode ? `, ${error.providerCode}` : ''}`
    : 'unexpected error';
  console.error(`SMTP ${command === 'check' ? 'login check' : 'test email'} failed (${detail}).`);
  if (known && error.category === 'unauthorized')
    console.error('Google refused the login: check the App Password (make smtp-credentials) and 2-Step Verification.');
  process.exitCode = 1;
} finally {
  await transport.close();
}
