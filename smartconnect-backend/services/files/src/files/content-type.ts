// Content type from the bytes, never from the file name or the client's header (ADR 0013). An allowlist: anything
// not recognised is application/octet-stream and is always served as a download.
export const OCTET_STREAM = 'application/octet-stream';

/** The only types a browser may render inline; everything else, PDF and text included, is a download. */
export const INLINE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Bytes of the file start kept for signature checks. */
export const SNIFF_HEAD_BYTES = 16 * 1024;

const startsWith = (head: Buffer, signature: number[], offset = 0): boolean =>
  head.length >= offset + signature.length && signature.every((byte, i) => head[offset + i] === byte);

/** ZIP container of an Office document: first entry is the OPC manifest, then the part folder names the kind. */
function officeType(head: Buffer): string | undefined {
  if (!startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || head.length < 30) return undefined;
  const nameLength = head.readUInt16LE(26);
  const firstEntry = head.toString('latin1', 30, 30 + nameLength);
  if (firstEntry !== '[Content_Types].xml' && firstEntry !== '_rels/.rels') return undefined;
  const text = head.toString('latin1');
  const found = [
    { type: DOCX, at: text.indexOf('word/') },
    { type: XLSX, at: text.indexOf('xl/') },
    { type: PPTX, at: text.indexOf('ppt/') },
  ]
    .filter((candidate) => candidate.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  return found?.type;
}

/** Observes a whole upload to decide whether it is UTF-8 text without NUL bytes. */
export class TextSniffer {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private valid = true;
  private bytes = 0;

  write(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (!this.valid) return;
    if (chunk.includes(0)) {
      this.valid = false;
      return;
    }
    try {
      this.decoder.decode(chunk, { stream: true });
    } catch {
      this.valid = false;
    }
  }

  isText(): boolean {
    if (!this.valid || this.bytes === 0) return false;
    try {
      this.decoder.decode(); // flush: a truncated multi-byte sequence at the end is invalid
      return true;
    } catch {
      return false;
    }
  }
}

/** The detected type from the first bytes (`head`) and the whole-body text verdict. */
export function detectContentType(head: Buffer, isText: boolean): string {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (head.toString('latin1', 0, 6) === 'GIF87a' || head.toString('latin1', 0, 6) === 'GIF89a') return 'image/gif';
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (head.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  const office = officeType(head);
  if (office) return office;
  return isText ? 'text/plain' : OCTET_STREAM;
}
