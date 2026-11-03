// AWS Signature Version 4 for the S3 API, which Cloudflare R2 implements: header-signed requests and presigned
// (query-signed) URLs. Built on node:crypto only, so the service needs no SDK. Paths are given raw ("/bucket/key")
// and encoded here once, the same way for the request line and the signature, as S3 expects (no double encoding).
// The secret key never leaves this module except as derived HMAC keys; nothing here logs.
import { createHash, createHmac } from 'node:crypto';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigningScope {
  region: string;
  /** "s3" for S3 and R2. */
  service: string;
}

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const ALGORITHM = 'AWS4-HMAC-SHA256';

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986: unreserved characters stay, everything else is %XX in upper case (encodeURIComponent leaves !'()*). */
export const uriEncode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** Each path segment encoded, the slashes kept. */
export const encodePath = (rawPath: string): string => rawPath.split('/').map(uriEncode).join('/');

/** Query parameters sorted by encoded name, then value, as `name=value` pairs joined by `&`. */
export function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/** 20130524T000000Z */
export const amzDateOf = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

export interface CanonicalInput {
  method: string;
  /** Unencoded, starting with "/". */
  path: string;
  query: Record<string, string>;
  /** Every header to sign, names in any case (Host included). */
  headers: Record<string, string>;
  payloadHash: string;
}

export interface Signature {
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
  credentialScope: string;
}

/** The core of SigV4: canonical request → string to sign → signature, at `amzDate` (YYYYMMDDTHHMMSSZ). */
export function signatureOf(
  input: CanonicalInput,
  credentials: S3Credentials,
  scope: SigningScope,
  amzDate: string,
): Signature {
  const headers = Object.entries(input.headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = headers.map(([name]) => name).join(';');
  const canonicalRequest = [
    input.method,
    encodePath(input.path),
    canonicalQuery(input.query),
    headers.map(([name, value]) => `${name}:${value}\n`).join(''),
    signedHeaders,
    input.payloadHash,
  ].join('\n');
  const day = amzDate.slice(0, 8);
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), scope.region), scope.service),
    'aws4_request',
  );
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  return { canonicalRequest, stringToSign, signature, signedHeaders, credentialScope };
}

export interface S3Request {
  method: string;
  /** host[:port], exactly as sent in the Host header. */
  host: string;
  path: string;
  query?: Record<string, string>;
  /** Further headers to sign and send (content-type, content-length, range, …). */
  headers?: Record<string, string>;
  /** SHA-256 of the body in hex (EMPTY_SHA256 for none): S3 verifies it against what it receives. */
  payloadHash: string;
}

/** Headers for a header-signed request: Host, X-Amz-Date, X-Amz-Content-Sha256, the given ones and Authorization. */
export function signedHeaders(
  request: S3Request,
  credentials: S3Credentials,
  scope: SigningScope,
  now: Date,
): Record<string, string> {
  const amzDate = amzDateOf(now);
  const headers: Record<string, string> = {
    ...request.headers,
    host: request.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': request.payloadHash,
  };
  const signed = signatureOf(
    {
      method: request.method,
      path: request.path,
      query: request.query ?? {},
      headers,
      payloadHash: request.payloadHash,
    },
    credentials,
    scope,
    amzDate,
  );
  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${signed.credentialScope}, SignedHeaders=${signed.signedHeaders}, Signature=${signed.signature}`,
  };
}

/**
 * A presigned URL (query-string authentication): anyone holding it may make exactly this request, for
 * `expiresInSeconds` from `now`. Only Host is signed, the payload is not (S3's rule for presigned GETs). `query`
 * (e.g. response-content-disposition) is covered by the signature, so it cannot be changed either.
 */
export function presignedUrl(
  request: { method: string; protocol: 'http:' | 'https:'; host: string; path: string; query?: Record<string, string> },
  credentials: S3Credentials,
  scope: SigningScope,
  now: Date,
  expiresInSeconds: number,
): string {
  const amzDate = amzDateOf(now);
  const query: Record<string, string> = {
    ...request.query,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${amzDate.slice(0, 8)}/${scope.region}/${scope.service}/aws4_request`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  const { signature } = signatureOf(
    {
      method: request.method,
      path: request.path,
      query,
      headers: { host: request.host },
      payloadHash: UNSIGNED_PAYLOAD,
    },
    credentials,
    scope,
    amzDate,
  );
  // The signature goes last, after the signed (canonical) query, as in AWS's own presigned URLs.
  return `${request.protocol}//${request.host}${encodePath(request.path)}?${canonicalQuery(query)}&X-Amz-Signature=${signature}`;
}
