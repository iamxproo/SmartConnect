// Runs synchronously in <head> before first paint so the page never flashes the wrong theme.
// Must stay in sync with src/lib/theme.tsx (storage key, accepted values, media query); a test checks both.
(function () {
  var preference = 'system';
  try {
    var stored = window.localStorage.getItem('sc-theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') preference = stored;
  } catch {
    // Storage can be unavailable (privacy mode, blocked site data): fall back to the system theme.
  }
  var prefersDark = Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  var theme = preference === 'dark' || (preference === 'system' && prefersDark) ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
})();
