// Readiness waits and ordered, idempotent shutdown for the hosted applications (decision D6, ADR 0016 decision 13).
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `url` answers 200; rejects after `timeoutMs`. Not-yet-listening and 503 both mean "not yet". */
export async function waitUntilReady(url: string, { timeoutMs = 60_000, intervalMs = 100 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await res.body?.cancel();
      if (res.status === 200) return;
    } catch {
      // not listening yet, or the probe timed out
    }
    if (Date.now() >= deadline) throw new Error(`not ready at ${url} within ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}

export interface Closable {
  close(): Promise<void>;
}

export interface CloseReport {
  /** Application names in the order their close() resolved. */
  closed: string[];
  failed: { name: string; error: string }[];
}

/**
 * Closes the started applications group by group, the applications of one group together, in the order given.
 * Applications that were never started are skipped. A failing close is recorded and never stops the others.
 */
export async function closeInGroups(
  started: ReadonlyMap<string, Closable>,
  groups: readonly (readonly string[])[],
): Promise<CloseReport> {
  const report: CloseReport = { closed: [], failed: [] };
  for (const group of groups) {
    await Promise.all(
      group
        .filter((name) => started.has(name))
        .map(async (name) => {
          try {
            await started.get(name)!.close();
            report.closed.push(name);
          } catch (error) {
            report.failed.push({ name, error: (error as Error).message });
          }
        }),
    );
  }
  return report;
}

/**
 * The process's only SIGTERM/SIGINT handler. The first signal starts the shutdown and exits with its code. A signal
 * within `duplicateWindowMs` of the first is the same request delivered twice (a terminal's Ctrl-C reaches both npm
 * and node, and npm forwards it), so it is ignored; a later one exits at once with 1.
 */
export function createSignalHandler(
  shutdown: () => Promise<number>,
  exit: (code: number) => void,
  { duplicateWindowMs = 1_000, now = Date.now, onForced = (_signal: string): void => undefined } = {},
): (signal: string) => void {
  let firstAt: number | undefined;
  return (signal) => {
    if (firstAt === undefined) {
      firstAt = now();
      void shutdown().then(exit);
      return;
    }
    if (now() - firstAt < duplicateWindowMs) return;
    onForced(signal);
    exit(1);
  };
}

export interface ShutdownResult extends CloseReport {
  timedOut: boolean;
}

/**
 * The shutdown, run once: every later call returns the same promise. Gives up waiting after `timeoutMs` (the
 * caller then exits non-zero); the closes already under way are not interrupted.
 */
export function onceWithDeadline(run: () => Promise<CloseReport>, timeoutMs: number): () => Promise<ShutdownResult> {
  let pending: Promise<ShutdownResult> | undefined;
  return () =>
    (pending ??= new Promise<ShutdownResult>((resolve) => {
      const timer = setTimeout(() => resolve({ closed: [], failed: [], timedOut: true }), timeoutMs);
      timer.unref();
      run().then(
        (report) => {
          clearTimeout(timer);
          resolve({ ...report, timedOut: false });
        },
        (error: unknown) => {
          clearTimeout(timer);
          resolve({ closed: [], failed: [{ name: 'shutdown', error: (error as Error).message }], timedOut: false });
        },
      );
    }));
}
