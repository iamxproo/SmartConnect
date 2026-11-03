import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { MotionConfig } from 'motion/react';
import { ToastProvider } from '@/components/toast/toaster';
import { AuthContext } from '@/lib/auth';
import { ApiContext, RealtimeContext } from '@/lib/services';
import { ThemeProvider } from '@/lib/theme';
import type { createAppRouter } from '@/router';

export function App({ router }: { router: ReturnType<typeof createAppRouter> }) {
  const { api, auth, queryClient, realtime } = router.options.context;
  return (
    // reducedMotion="user": Motion drops transform/layout animation when the OS asks for reduced motion.
    <MotionConfig reducedMotion="user">
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ApiContext value={api}>
            <RealtimeContext value={realtime}>
              <AuthContext value={auth}>
                <ToastProvider>
                  <RouterProvider router={router} />
                </ToastProvider>
              </AuthContext>
            </RealtimeContext>
          </ApiContext>
        </QueryClientProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}
