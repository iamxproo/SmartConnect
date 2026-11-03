import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Inbox } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { EmptyState } from './empty-state';
import { ErrorState, RouteErrorState } from './error-state';
import { LoadingState, SKELETON_DELAY_MS } from './loading-state';

describe('LoadingState', () => {
  it('announces loading immediately but shows skeletons only after the delay (no flash on fast loads)', () => {
    vi.useFakeTimers();
    try {
      render(<LoadingState label="Loading channels" />);
      const status = screen.getByRole('status');
      expect(status).toHaveAttribute('aria-busy', 'true');
      expect(status).toHaveTextContent('Loading channels…');
      expect(screen.queryByTestId('loading-skeleton')).not.toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(SKELETON_DELAY_MS);
      });
      expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('EmptyState', () => {
  it('is a region labelled by its heading, with an optional action', () => {
    render(<EmptyState icon={Inbox} title="Nothing here" description="Nothing yet." action={<button>Do it</button>} />);
    expect(screen.getByRole('region', { name: 'Nothing here' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Do it' })).toBeInTheDocument();
  });
});

describe('ErrorState', () => {
  it('is announced as an alert and offers a retry', async () => {
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows technical details only in development builds', () => {
    vi.stubEnv('DEV', false);
    const { unmount } = render(<ErrorState details="TypeError: x is undefined" />);
    expect(screen.queryByText('TypeError: x is undefined')).not.toBeInTheDocument();
    unmount();

    vi.stubEnv('DEV', true);
    render(<ErrorState details="TypeError: x is undefined" />);
    expect(screen.getByText('TypeError: x is undefined')).toBeInTheDocument();
    vi.unstubAllEnvs();
  });
});

describe('RouteErrorState', () => {
  it('contains a failing route and recovers when retried', async () => {
    let shouldFail = true;
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const flakyRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: function Flaky() {
        if (shouldFail) throw new Error('boom');
        return <p>Recovered</p>;
      },
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([flakyRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
      defaultErrorComponent: RouteErrorState,
    });
    // React logs caught render errors; keep the test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<RouterProvider router={router} />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    shouldFail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Recovered')).toBeInTheDocument();
  });
});
