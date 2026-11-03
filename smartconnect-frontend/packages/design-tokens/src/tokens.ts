// SmartConnect design tokens: the single source of truth for web (CSS variables) and, later, mobile.
// Spec: docs/architecture/design-system.md.
//
// PROVISIONAL PALETTE: brand identity (hues, typeface) is an open product decision. The values below are
// a neutral placeholder that passes the WCAG checks in test/tokens.test.ts. Rebranding changes values
// here only; names are stable.

export const colorTokenNames = [
  'bg',
  'bg-subtle',
  'surface',
  'surface-raised',
  'surface-hover',
  'surface-selected',
  'overlay',
  'border',
  'border-strong',
  'text',
  'text-muted',
  'text-inverse',
  'primary',
  'primary-hover',
  'primary-fg',
  'accent',
  'accent-fg',
  'success',
  'warning',
  'danger',
  'danger-fg',
  'info',
  'focus-ring',
  'presence-online',
  'presence-away',
  'presence-busy',
  'presence-dnd',
  'presence-offline',
] as const;

export type ColorToken = (typeof colorTokenNames)[number];
export const themeNames = ['light', 'dark'] as const;
export type ThemeName = (typeof themeNames)[number];

export const colors: Record<ThemeName, Record<ColorToken, string>> = {
  light: {
    bg: '#ffffff',
    'bg-subtle': '#f5f6f8',
    surface: '#ffffff',
    'surface-raised': '#ffffff',
    'surface-hover': '#eceef2',
    'surface-selected': '#e1e7f1',
    overlay: 'rgb(9 11 16 / 0.5)',
    border: '#e0e3e8',
    'border-strong': '#7b8494',
    text: '#11151c',
    'text-muted': '#555e6d',
    'text-inverse': '#ffffff',
    primary: '#2356d4',
    'primary-hover': '#1b46ae',
    'primary-fg': '#ffffff',
    accent: '#7a3fd1',
    'accent-fg': '#ffffff',
    success: '#17763a',
    warning: '#8f5d00',
    danger: '#c42a2a',
    'danger-fg': '#ffffff',
    info: '#0b679f',
    'focus-ring': '#2356d4',
    'presence-online': '#1d8a4a',
    'presence-away': '#a66b0b',
    'presence-busy': '#c42a2a',
    'presence-dnd': '#9c2a63',
    'presence-offline': '#7b8494',
  },
  dark: {
    bg: '#0e1116',
    'bg-subtle': '#14181e',
    surface: '#14181e',
    'surface-raised': '#1b2028',
    'surface-hover': '#232a34',
    'surface-selected': '#2b3543',
    overlay: 'rgb(0 0 0 / 0.6)',
    border: '#29303a',
    'border-strong': '#6a7586',
    text: '#e7eaef',
    'text-muted': '#a1aab7',
    'text-inverse': '#0e1116',
    primary: '#7ea4ff',
    'primary-hover': '#9ab8ff',
    'primary-fg': '#0e1116',
    accent: '#b598ff',
    'accent-fg': '#0e1116',
    success: '#4cc477',
    warning: '#d9ad3c',
    danger: '#ff7d74',
    'danger-fg': '#0e1116',
    info: '#5cadff',
    'focus-ring': '#7ea4ff',
    'presence-online': '#3fbf6f',
    'presence-away': '#d9a23c',
    'presence-busy': '#ff7d74',
    'presence-dnd': '#f27bb5',
    'presence-offline': '#7c8696',
  },
};

export const shadows: Record<ThemeName, Record<'sm' | 'md' | 'lg', string>> = {
  light: {
    sm: '0 1px 2px rgb(16 24 40 / 0.06)',
    md: '0 4px 12px rgb(16 24 40 / 0.10)',
    lg: '0 12px 32px rgb(16 24 40 / 0.16)',
  },
  dark: {
    sm: '0 1px 2px rgb(0 0 0 / 0.40)',
    md: '0 4px 12px rgb(0 0 0 / 0.45)',
    lg: '0 12px 32px rgb(0 0 0 / 0.55)',
  },
};

export const typography = {
  fontFamily: {
    // System stack until the brand typeface is decided (no web-font download, no licence question).
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  },
  // rem; "base" (0.875rem) is the body size.
  fontSize: {
    xs: '0.75rem',
    sm: '0.8125rem',
    base: '0.875rem',
    md: '1rem',
    lg: '1.125rem',
    xl: '1.25rem',
    '2xl': '1.5rem',
    '3xl': '1.875rem',
  },
  lineHeight: { tight: '1.25', normal: '1.5' },
  fontWeight: { regular: '400', medium: '500', semibold: '600' },
} as const;

export const radius = { sm: '4px', md: '6px', lg: '8px', xl: '12px', full: '9999px' } as const;

export const zIndex = {
  base: '0',
  sticky: '10',
  dropdown: '20',
  overlay: '30',
  modal: '40',
  toast: '50',
  'call-overlay': '60',
} as const;

export const motion = {
  duration: { instant: '80ms', fast: '120ms', base: '200ms', slow: '320ms' },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    enter: 'cubic-bezier(0, 0, 0, 1)',
    exit: 'cubic-bezier(0.3, 0, 1, 1)',
  },
} as const;
