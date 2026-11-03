import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { ContextQueryDto, PostMessageDto } from '../src/messages/dto.js';

const ID = '0192b5f0-0000-7000-8000-000000000001';
const errorsOf = async (plain: object) =>
  (await validate(plainToInstance(PostMessageDto, plain))).map((e) => e.property).sort();

describe('PostMessageDto', () => {
  it('needs a non-blank body when there are no attachments', async () => {
    expect(await errorsOf({ body: 'hello' })).toEqual([]);
    for (const plain of [{}, { body: '' }, { body: '  \n ' }, { body: 'x', attachmentFileIds: 'nope' }]) {
      expect(await errorsOf(plain), JSON.stringify(plain)).not.toEqual([]);
    }
    // An empty list of attachments is no attachments.
    expect(await errorsOf({ body: '', attachmentFileIds: [] })).toEqual(['body']);
  });

  it('allows an empty or missing body with attachments, but still refuses a non-string or NUL body', async () => {
    expect(await errorsOf({ attachmentFileIds: [ID] })).toEqual([]);
    expect(await errorsOf({ body: '', attachmentFileIds: [ID] })).toEqual([]);
    expect(await errorsOf({ body: '   ', attachmentFileIds: [ID] })).toEqual([]);
    expect(await errorsOf({ body: 5, attachmentFileIds: [ID] })).toEqual(['body']);
    expect(await errorsOf({ body: 'a\u0000b', attachmentFileIds: [ID] })).toEqual(['body']);
  });

  it('allows at most 10 distinct uuids, case-insensitively', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `0192b5f0-0000-7000-8000-0000000000${String(i).padStart(2, '0')}`);
    expect(await errorsOf({ attachmentFileIds: ids.slice(0, 10) })).toEqual([]);
    expect(await errorsOf({ attachmentFileIds: ids })).toEqual(['attachmentFileIds']);
    expect(await errorsOf({ attachmentFileIds: [ID, ID] })).toEqual(['attachmentFileIds']);
    expect(await errorsOf({ attachmentFileIds: [ID, ID.toUpperCase()] })).toEqual(['attachmentFileIds']);
    expect(await errorsOf({ attachmentFileIds: ['not-a-uuid'] })).toEqual(['attachmentFileIds']);
  });
});

describe('ContextQueryDto', () => {
  const bad = async (plain: object) => (await validate(plainToInstance(ContextQueryDto, plain))).length > 0;
  it('takes before and after from 0 to 25', async () => {
    expect(await bad({})).toBe(false);
    expect(await bad({ before: '0', after: '25' })).toBe(false);
    for (const plain of [{ before: '26' }, { after: '-1' }, { before: 'x' }, { after: '1.5' }])
      expect(await bad(plain), JSON.stringify(plain)).toBe(true);
  });
});
