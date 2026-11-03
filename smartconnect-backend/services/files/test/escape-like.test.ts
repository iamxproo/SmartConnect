import { describe, expect, it } from 'vitest';
import { escapeLike } from '../src/files/files.service.js';

describe('escapeLike', () => {
  it('escapes the backslash first and both LIKE wildcards', () => {
    expect(escapeLike('100%_done')).toBe('100\\%\\_done');
    expect(escapeLike('a\\b')).toBe('a\\\\b');
    expect(escapeLike('\\%')).toBe('\\\\\\%');
    expect(escapeLike('plain')).toBe('plain');
  });
});
