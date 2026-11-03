import { Badge } from '@smartconnect/ui/components/badge';
import { Button } from '@smartconnect/ui/components/button';
import { AnimatePresence, motion } from 'motion/react';
import { MonitorSmartphone } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog';
import { Card } from '@/components/page';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import { useToast } from '@/components/toast/toaster';
import type { Session } from '@/lib/api/types';
import { useAuthStore } from '@/lib/auth';
import { enterTransition } from '@/lib/motion';
import { useLogoutEverywhere, useRevokeOtherSessions, useRevokeSession, useSessions } from '@/lib/queries/account';

/** Browser and system from a User-Agent string; "Unknown device" when it says nothing useful. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : null;
  const system = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad/.test(userAgent)
        ? 'iOS'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? 'Unknown device';
}

const formatTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function SessionsPage() {
  const sessions = useSessions();
  return (
    <QueryState query={sessions} label="sessions">
      {(list) =>
        list.length === 0 ? (
          <EmptyState icon={MonitorSmartphone} title="No active sessions" description="Nothing to show right now." />
        ) : (
          <SessionList sessions={list} />
        )
      }
    </QueryState>
  );
}

type Pending = { kind: 'one'; session: Session } | { kind: 'others' } | { kind: 'all' } | null;

function SessionList({ sessions }: { sessions: Session[] }) {
  const toast = useToast();
  const auth = useAuthStore();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const logoutAll = useLogoutEverywhere();
  const [pending, setPending] = useState<Pending>(null);
  const hasOthers = sessions.some((session) => !session.current);

  // The server ended this browser's session too; clear local state so the shell returns to sign in.
  const leave = () => auth.logout().catch(() => undefined);

  const copy = (() => {
    if (pending?.kind === 'one') {
      return pending.session.current
        ? {
            title: 'Sign out of this device?',
            description: 'This ends the session you are using now. You will be taken to the sign-in page.',
            confirm: 'Sign out',
          }
        : {
            title: 'End this session?',
            description: `${describeDevice(pending.session.userAgent)} will be signed out and must sign in again.`,
            confirm: 'End session',
          };
    }
    if (pending?.kind === 'others') {
      return {
        title: 'Sign out of other devices?',
        description: 'Every session except this one is ended. Those devices must sign in again.',
        confirm: 'Sign out other devices',
      };
    }
    return {
      title: 'Sign out everywhere?',
      description: 'Every session, including this one, is ended. You will be taken to the sign-in page.',
      confirm: 'Sign out everywhere',
    };
  })();

  return (
    <section aria-labelledby="sessions-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="sessions-heading" className="font-medium">
          Active sessions
        </h3>
        <div className="flex gap-2">
          {hasOthers ? (
            <Button variant="outline" size="sm" onClick={() => setPending({ kind: 'others' })}>
              Sign out other devices
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={() => setPending({ kind: 'all' })}>
            Sign out everywhere
          </Button>
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {sessions.map((session) => (
            <motion.li
              key={session.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={enterTransition}
            >
              <Card className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {describeDevice(session.userAgent)}
                    {session.current ? <Badge>This device</Badge> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {session.ipAddress ? `${session.ipAddress} · ` : ''}Last active {formatTime(session.lastUsedAt)} ·
                    Signed in {formatTime(session.createdAt)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={
                    session.current
                      ? 'Sign out of this device'
                      : `End session on ${describeDevice(session.userAgent)}, last active ${formatTime(session.lastUsedAt)}`
                  }
                  onClick={() => setPending({ kind: 'one', session })}
                >
                  {session.current ? 'Sign out' : 'End session'}
                </Button>
              </Card>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={copy.title}
        description={copy.description}
        confirmLabel={copy.confirm}
        onConfirm={async () => {
          if (pending?.kind === 'one') {
            await revoke.mutateAsync({ id: pending.session.id, current: pending.session.current });
            if (pending.session.current) await leave();
            else toast({ title: 'Session ended' });
          } else if (pending?.kind === 'others') {
            await revokeOthers.mutateAsync();
            toast({ title: 'Signed out of other devices' });
          } else {
            await logoutAll.mutateAsync();
            await leave();
          }
        }}
      />
    </section>
  );
}
