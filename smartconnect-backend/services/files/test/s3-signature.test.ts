// SigV4 against the published examples: the AWS SigV4 test suite ("get-vanilla") and the S3 API reference
// (header-signed GET Object, PUT Object, GET Bucket Lifecycle, GET Bucket, and the presigned URL example).
import { describe, expect, it } from 'vitest';
import {
  amzDateOf,
  canonicalQuery,
  EMPTY_SHA256,
  presignedUrl,
  sha256Hex,
  signatureOf,
  signedHeaders,
  uriEncode,
} from '../src/storage/s3-signature.js';

const S3_EXAMPLE = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const S3_SCOPE = { region: 'us-east-1', service: 's3' };
const MAY_24_2013 = new Date('2013-05-24T00:00:00Z');
const HOST = 'examplebucket.s3.amazonaws.com';
const signatureIn = (authorization: string) => /Signature=([0-9a-f]{64})$/.exec(authorization)?.[1];

describe('SigV4', () => {
  it('get-vanilla (AWS SigV4 test suite)', () => {
    const signed = signatureOf(
      {
        method: 'GET',
        path: '/',
        query: {},
        headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
        payloadHash: EMPTY_SHA256,
      },
      { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' },
      { region: 'us-east-1', service: 'service' },
      '20150830T123600Z',
    );
    expect(signed.signedHeaders).toBe('host;x-amz-date');
    expect(signed.signature).toBe('5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  it('S3 GET Object with a Range header', () => {
    const headers = signedHeaders(
      { method: 'GET', host: HOST, path: '/test.txt', headers: { range: 'bytes=0-9' }, payloadHash: EMPTY_SHA256 },
      S3_EXAMPLE,
      S3_SCOPE,
      MAY_24_2013,
    );
    expect(headers.authorization).toContain(
      'Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date',
    );
    expect(signatureIn(headers.authorization!)).toBe(
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });

  it('S3 PUT Object: the payload hash and a path character that must be encoded', () => {
    const body = 'Welcome to Amazon S3.';
    expect(sha256Hex(body)).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const headers = signedHeaders(
      {
        method: 'PUT',
        host: HOST,
        path: '/test$file.text',
        headers: { date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
        payloadHash: sha256Hex(body),
      },
      S3_EXAMPLE,
      S3_SCOPE,
      MAY_24_2013,
    );
    expect(signatureIn(headers.authorization!)).toBe(
      '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd',
    );
  });

  it('S3 GET Bucket Lifecycle: a query parameter without a value', () => {
    const headers = signedHeaders(
      { method: 'GET', host: HOST, path: '/', query: { lifecycle: '' }, payloadHash: EMPTY_SHA256 },
      S3_EXAMPLE,
      S3_SCOPE,
      MAY_24_2013,
    );
    expect(signatureIn(headers.authorization!)).toBe(
      'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  it('S3 GET Bucket (list objects): sorted query parameters', () => {
    const headers = signedHeaders(
      { method: 'GET', host: HOST, path: '/', query: { prefix: 'J', 'max-keys': '2' }, payloadHash: EMPTY_SHA256 },
      S3_EXAMPLE,
      S3_SCOPE,
      MAY_24_2013,
    );
    expect(signatureIn(headers.authorization!)).toBe(
      '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7',
    );
  });

  it('S3 presigned URL', () => {
    const url = presignedUrl(
      { method: 'GET', protocol: 'https:', host: HOST, path: '/test.txt' },
      S3_EXAMPLE,
      S3_SCOPE,
      MAY_24_2013,
      86400,
    );
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('encodes as RFC 3986 requires, and formats the date', () => {
    expect(uriEncode("a b+c/d~e!'()*")).toBe('a%20b%2Bc%2Fd~e%21%27%28%29%2A');
    expect(canonicalQuery({ b: '2', a: '1', 'a b': 'x y' })).toBe('a=1&a%20b=x%20y&b=2');
    expect(amzDateOf(new Date('2026-11-04T09:08:07.654Z'))).toBe('20261104T090807Z');
  });
});
