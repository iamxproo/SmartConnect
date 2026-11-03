// File names are display data only: they are never used as a path, but they reach headers and the UI, so they are
// reduced to something harmless first. Names are never logged.
export const MAX_NAME_LENGTH = 255;
export const MAX_RAW_NAME_LENGTH = 1024;

// C0/C1 controls, bidi embeddings/overrides/isolates (the "photo\u202Egpj.exe" trick), zero-width and BOM characters.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** The sanitized display name, or undefined when nothing usable is left. */
export function sanitizeFileName(raw: string): string | undefined {
  const segments = raw.normalize('NFC').replace(UNSAFE, '').split(/[/\\]/);
  // Path separators are dropped together with everything before the last one: "../../etc/passwd" → "passwd".
  let name = (segments.pop() ?? '').trim().replace(/[. ]+$/, '');
  if (name === '' || /^\.+$/.test(name)) return undefined;
  if ([...name].length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
    name =
      [...name.slice(0, extension ? dot : name.length)].slice(0, MAX_NAME_LENGTH - extension.length).join('') +
      extension;
  }
  return name;
}

/** Content-Disposition value: an ASCII fallback plus the RFC 5987/8187 UTF-8 `filename*`. */
export function contentDisposition(disposition: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
