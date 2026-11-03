// Controllable `prefers-color-scheme` for tests (jsdom has no matchMedia).
type Listener = (event: MediaQueryListEvent) => void;

const state = { dark: false, listeners: new Set<Listener>() };

export function installMatchMedia(): void {
  window.matchMedia = (query: string) =>
    ({
      matches: query.includes('prefers-color-scheme: dark') ? state.dark : false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: Listener) => state.listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => state.listeners.delete(listener),
      addListener: (listener: Listener) => state.listeners.add(listener),
      removeListener: (listener: Listener) => state.listeners.delete(listener),
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

/** Simulates the operating system switching between light and dark appearance. */
export function setSystemDark(dark: boolean): void {
  state.dark = dark;
  for (const listener of state.listeners) listener({ matches: dark } as MediaQueryListEvent);
}

export function resetMatchMedia(): void {
  state.dark = false;
  state.listeners.clear();
}
