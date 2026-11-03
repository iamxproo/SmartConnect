import { describe, expect, it } from 'vitest';
import { detectContentType, INLINE_TYPES, TextSniffer } from '../src/files/content-type.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const detect = (data: Buffer | string) => {
  const buffer = Buffer.from(data);
  const sniffer = new TextSniffer();
  sniffer.write(buffer);
  return detectContentType(buffer, sniffer.isText());
};

/** A minimal ZIP local-file header for `name`, followed by `rest`. */
const zip = (name: string, rest = '') => {
  const header = Buffer.alloc(30);
  header.write('PK\x03\x04', 0, 'latin1');
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, Buffer.from(name), Buffer.from(rest)]);
};

describe('detectContentType', () => {
  it('recognises the allowlisted binary signatures', () => {
    expect(detect(PNG)).toBe('image/png');
    expect(detect(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBe('image/jpeg');
    expect(detect('GIF89a\u0001\u0000')).toBe('image/gif');
    expect(detect('GIF87a\u0001\u0000')).toBe('image/gif');
    expect(detect(Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBPVP8 ')]))).toBe(
      'image/webp',
    );
    expect(detect('%PDF-1.7\n%âãÏÓ')).toBe('application/pdf');
  });

  it('recognises Office documents by their ZIP manifest and part folder', () => {
    expect(detect(zip('[Content_Types].xml', '...word/document.xml'))).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(detect(zip('[Content_Types].xml', '_rels/.rels xl/workbook.xml'))).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(detect(zip('_rels/.rels', 'ppt/presentation.xml'))).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
  });

  it('treats other ZIPs, and Office-looking ZIPs without a manifest, as opaque', () => {
    expect(detect(zip('hello.txt', 'word/'))).toBe('application/octet-stream');
    expect(detect(zip('[Content_Types].xml', 'nothing recognisable'))).toBe('application/octet-stream');
    expect(detect(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe('application/octet-stream');
  });

  it('accepts UTF-8 text without NUL bytes as text/plain', () => {
    expect(detect('hello, wörld\n日本語')).toBe('text/plain');
  });

  it('refuses text that is not valid UTF-8, contains NUL, or is empty', () => {
    expect(detect(Buffer.from([0x68, 0x69, 0xff, 0xfe]))).toBe('application/octet-stream');
    expect(detect(Buffer.from('hello\0world'))).toBe('application/octet-stream');
    expect(detect(Buffer.alloc(0))).toBe('application/octet-stream');
    expect(detect(Buffer.from([0xe6, 0x97]))).toBe('application/octet-stream'); // truncated multi-byte sequence
  });

  it('sniffs UTF-8 across chunk boundaries and finds a NUL late in the body', () => {
    const bytes = Buffer.from('日本語');
    const split = new TextSniffer();
    split.write(bytes.subarray(0, 4));
    split.write(bytes.subarray(4));
    expect(split.isText()).toBe(true);
    const late = new TextSniffer();
    late.write(Buffer.from('plain text'));
    late.write(Buffer.from([0x00]));
    expect(late.isText()).toBe(false);
  });

  it('never trusts the content to be what a name claims: HTML and SVG are plain text, never inline', () => {
    for (const body of [
      '<!doctype html><script>alert(1)</script>',
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
      '<?xml version="1.0"?><svg/>',
    ]) {
      const type = detect(body);
      expect(type).toBe('text/plain');
      expect(INLINE_TYPES.has(type)).toBe(false);
    }
  });

  it('does not let a signature appear anywhere but the start', () => {
    expect(detect(Buffer.concat([Buffer.from('<html>'), PNG]))).toBe('application/octet-stream');
    expect(detect('  %PDF-1.4')).toBe('text/plain');
  });

  it('inlines only PNG, JPEG, GIF and WebP', () => {
    expect([...INLINE_TYPES].sort()).toEqual(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  });
});
