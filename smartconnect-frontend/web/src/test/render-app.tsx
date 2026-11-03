import { createMemoryHistory } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { App } from '@/app';
import { createServices } from '@/lib/services';
import { createAppRouter } from '@/router';
import { createFakeRealtime } from './realtime-fake';

/** Renders the real application (real route tree, providers and shell) at `path`, using in-memory history. Call
 * `stubApi` first: the app talks to the network only through `fetch`, plus a fake realtime client. */
export async function renderApp(path = '/') {
  const realtime = createFakeRealtime();
  const services = createServices({ realtime });
  const router = createAppRouter({ history: createMemoryHistory({ initialEntries: [path] }), services });
  const user = userEvent.setup();
  const view = render(<App router={router} />);
  await screen.findByRole('main');
  return { ...view, router, services, user, realtime };
}

/** axe-core accessibility violations for the whole document. Colour contrast is verified on the tokens instead
 * (packages/design-tokens tests), because jsdom does not compute styles. */
export async function axeViolations(): Promise<string[]> {
  const results = await axe.run(document.body, {
    resultTypes: ['violations'],
    rules: { 'color-contrast': { enabled: false } },
  });
  return results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`);
}
