import { cn } from '@smartconnect/ui/lib/utils';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { createContext, use, useCallback, useRef, useState, type ReactNode } from 'react';
import { enterTransition } from '@/lib/motion';

interface ToastInput {
  title: string;
  description?: string;
  tone?: 'success' | 'error' | 'info';
}
interface ToastItem extends ToastInput {
  id: number;
}

const DISMISS_AFTER_MS = 6000;
const MAX_VISIBLE = 4;

const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

export function useToast(): (toast: ToastInput) => void {
  const show = use(ToastContext);
  if (!show) throw new Error('useToast must be used inside <ToastProvider>');
  return show;
}

/** Transient confirmations and failures. Errors are announced assertively, everything else politely. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const show = useCallback(
    (toast: ToastInput) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(1 - MAX_VISIBLE), { ...toast, id }]);
      window.setTimeout(() => dismiss(id), DISMISS_AFTER_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext value={show}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        className="pointer-events-none fixed right-4 bottom-4 z-(--sc-z-toast) flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              role={toast.tone === 'error' ? 'alert' : 'status'}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 24, transition: { duration: 0.15 } }}
              transition={enterTransition}
              className={cn(
                'pointer-events-auto flex items-start gap-2 rounded-lg border border-border border-l-4 bg-popover p-3 text-sm text-popover-foreground shadow-md',
                toast.tone === 'error'
                  ? 'border-l-danger'
                  : toast.tone === 'info'
                    ? 'border-l-info'
                    : 'border-l-success',
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">{toast.title}</p>
                {toast.description ? <p className="mt-0.5 text-muted-foreground">{toast.description}</p> : null}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismiss(toast.id)}
                className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext>
  );
}
