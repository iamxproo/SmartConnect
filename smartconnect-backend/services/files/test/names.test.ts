import { describe, expect, it } from 'vitest';
import { contentDisposition, MAX_NAME_LENGTH, sanitizeFileName } from '../src/files/names.js';

describe('sanitizeFileName', () => {
  it('keeps ordinary names, including unicode', () => {
    expect(sanitizeFileName('Quarterly report (final).pdf')).toBe('Quarterly report (final).pdf');
    expect(sanitizeFileName('résumé 日本語.docx')).toBe('résumé 日本語.docx');
  });

  it('drops directories: only the last path segment survives', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\me\\secret.txt')).toBe('secret.txt');
    expect(sanitizeFileName('a/b\\c/d.png')).toBe('d.png');
  });

  it('removes control, zero-width and direction-override characters', () => {
    expect(sanitizeFileName('a\u0000b\u001fc\u007fd.txt')).toBe('abcd.txt');
    expect(sanitizeFileName('photo\u202Egpj.exe')).toBe('photogpj.exe');
    expect(sanitizeFileName('x\u200by\ufeffz.txt')).toBe('xyz.txt');
  });

  it('refuses names with nothing usable left', () => {
    for (const name of ['', '   ', '.', '..', '...', '/', '\\\\', '\u0000\u0001', 'dir/'])
      expect(sanitizeFileName(name)).toBeUndefined();
  });

  it('strips trailing dots and spaces', () => {
    expect(sanitizeFileName('report.txt. . ')).toBe('report.txt');
  });

  it('shortens long names but keeps a short extension', () => {
    const name = sanitizeFileName(`${'a'.repeat(400)}.pdf`)!;
    expect([...name]).toHaveLength(MAX_NAME_LENGTH);
    expect(name.endsWith('.pdf')).toBe(true);
    expect([...sanitizeFileName('é'.repeat(400))!]).toHaveLength(MAX_NAME_LENGTH);
  });
});

describe('contentDisposition', () => {
  it('encodes the name for headers (RFC 5987) with an ASCII fallback', () => {
    expect(contentDisposition('attachment', 'résumé "v2".pdf')).toBe(
      `attachment; filename="r_sum_ _v2_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22.pdf`,
    );
  });

  it('cannot be broken out of with quotes, semicolons or newlines', () => {
    const value = contentDisposition('inline', 'a";\r\nSet-Cookie: x=1;b.png');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value.match(/filename="([^"]*)"/)![1]).not.toMatch(/[";]/);
  });
});
