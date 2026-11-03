import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseServiceUrl, readSecret } from '../src/config/env.js';

describe('readSecret', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'backend-kit-'));
  const file = path.join(dir, 'secret');
  writeFileSync(file, 's3cret-value\n');

  it('reads NAME, or the trimmed contents of NAME_FILE', () => {
    const problems: string[] = [];
    expect(readSecret({ TOKEN: ' direct ' }, 'TOKEN', problems)).toBe('direct');
    expect(readSecret({ TOKEN_FILE: file }, 'TOKEN', problems)).toBe('s3cret-value');
    expect(readSecret({}, 'TOKEN', problems)).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it('rejects both forms at once, unreadable and empty files, without echoing values', () => {
    const empty = path.join(dir, 'empty');
    writeFileSync(empty, '\n');
    const problems: string[] = [];
    readSecret({ TOKEN: 'a', TOKEN_FILE: file }, 'TOKEN', problems);
    readSecret({ TOKEN_FILE: path.join(dir, 'missing') }, 'TOKEN', problems);
    readSecret({ TOKEN_FILE: empty }, 'TOKEN', problems);
    expect(problems).toEqual([
      'set either TOKEN or TOKEN_FILE, not both',
      'TOKEN_FILE could not be read (check the path and permissions)',
      'TOKEN_FILE points to an empty file',
    ]);
    expect(problems.join(' ')).not.toContain('s3cret-value');
  });
});

describe('parseServiceUrl', () => {
  it('accepts http(s) URLs and drops a trailing slash', () => {
    const problems: string[] = [];
    expect(parseServiceUrl('X', 'http://identity.internal:3101/', problems)).toBe('http://identity.internal:3101');
    expect(problems).toEqual([]);
  });

  it.each(['ftp://x', 'http://u:p@x', 'http://x/?a=1', 'http://x/#f', 'not a url'])('rejects %s', (raw) => {
    const problems: string[] = [];
    parseServiceUrl('X', raw, problems);
    expect(problems).toEqual(['X must be an http(s) URL without credentials, query or fragment']);
  });
});
