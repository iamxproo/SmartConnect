const UNITS = ['B', 'KB', 'MB', 'GB'];

/** "812 B", "1.4 MB": decimal units, one decimal above bytes. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${UNITS[unit]}`;
}

const TYPE_LABELS: Record<string, string> = {
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/gif': 'GIF image',
  'image/webp': 'WebP image',
  'application/pdf': 'PDF document',
  'text/plain': 'Text file',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel spreadsheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint presentation',
};

export const typeLabel = (mimeType: string): string => TYPE_LABELS[mimeType] ?? 'File';

/** The types the server serves inline (and the only ones previewed here). */
export const isPreviewableImage = (mimeType: string): boolean =>
  ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType);
