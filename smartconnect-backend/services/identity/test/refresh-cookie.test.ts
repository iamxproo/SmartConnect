import { describe, expect, it } from 'vitest';
import { clearedRefreshCookie, readRefreshCookie, refreshCookie } from '../src/auth/refresh-cookie.js';

describe('refresh cookie', () => {
  it('is HttpOnly, Secure, SameSite=Strict, __Secure- prefixed and scoped to /api/v1/auth', () => {
    expect(refreshCookie('tok', 3600.9)).toBe(
      '__Secure-sc_refresh=tok; Max-Age=3600; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict',
    );
  });

  it('is cleared with Max-Age=0 and the same attributes', () => {
    expect(clearedRefreshCookie()).toBe(
      '__Secure-sc_refresh=; Max-Age=0; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict',
    );
  });

  it('is read from a Cookie header among other cookies', () => {
    expect(readRefreshCookie('a=1; __Secure-sc_refresh=abc_DEF-123; b=2')).toBe('abc_DEF-123');
    expect(readRefreshCookie('sc_refresh=spoof; other=1')).toBeUndefined();
    expect(readRefreshCookie('__Secure-sc_refresh=')).toBeUndefined();
    expect(readRefreshCookie(undefined)).toBeUndefined();
  });
});
