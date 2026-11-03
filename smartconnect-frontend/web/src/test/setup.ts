import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { forgetInvitationToken } from '@/lib/hash-token';
import { installMatchMedia, resetMatchMedia } from './media';

// jsdom gaps that Radix primitives rely on.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;
const elementStubs = { scrollIntoView: () => {}, hasPointerCapture: () => false, releasePointerCapture: () => {} };
for (const [name, value] of Object.entries(elementStubs)) {
  if (!(name in Element.prototype)) {
    Object.defineProperty(Element.prototype, name, { value, configurable: true, writable: true });
  }
}

beforeEach(() => {
  installMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  forgetInvitationToken();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.colorScheme = '';
  document.title = '';
  resetMatchMedia();
});
