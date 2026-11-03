// Cloudflare R2 driver (ADR 0006), through R2's S3-compatible API with SigV4 (s3-signature.ts) over node:http(s): no
// SDK. The bucket stays private: every request is signed with the service's own credentials, and reads by anyone else
// need a presigned URL the service makes only after its own authorization (signedReadUrl). Objects are addressed
// path-style, /<bucket>/<organization>/<file>/<version>, and every key is validated before use.
//
// Uploads are staged on local disk first (staging.ts: limits, sniffing, SHA-256), so nothing reaches R2 unless every
// byte arrived and matched the declaration; promote() then PUTs the staged file with its SHA-256, which R2 checks.
// Failures become StorageUnavailableError with a loggable category, never a URL, signature or credential. Transient
// ones (network, timeout, 429, 5xx) are retried a few times; nothing ever falls back to another provider.
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Readable } from 'node:stream';
import {
  assertStorageKey,
  StorageNotFoundError,
  StorageUnavailableError,
  type FileStorage,
  type ObjectMetadata,
  type SignedReadOptions,
  type StageLimits,
  type StagedObject,
} from './file-storage.js';
import {
  canonicalQuery,
  EMPTY_SHA256,
  encodePath,
  presignedUrl,
  signedHeaders,
  type S3Credentials,
} from './s3-signature.js';
import { stageToFile, sweepDirectory } from './staging.js';

export interface R2Options {
  /** https://<account id>.r2.cloudflarestorage.com (no path); http://127.0.0.1:<port> only for local fakes. */
  endpoint: URL;
  bucket: string;
  /** "auto" for R2. */
  region: string;
  credentials: S3Credentials;
  /** Per request (connection, idle socket). */
  timeoutMs: number;
  /** Where uploads are staged before they are sent. */
  stagingDir: string;
  /** Tests: the clock that dates signatures. */
  now?: () => Date;
  /** Further attempts after a transient failure (default 2), with backoff from `retryDelayMs` (default 200). */
  retries?: number;
  retryDelayMs?: number;
}

interface Answer {
  status: number;
  headers: IncomingMessage['headers'];
  body: IncomingMessage;
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const MAX_ERROR_BODY = 64 * 1024;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readText(body: Readable, limit = 8 * 1024 * 1024): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of body) {
    size += (part as Buffer).length;
    if (size > limit) {
      body.destroy();
      throw new StorageUnavailableError('unexpected_response', 'storage answer too large');
    }
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts).toString('utf8');
}

/** The S3 error code (SignatureDoesNotMatch, NoSuchKey, …): safe to log, unlike the rest of an error body. */
const errorCodeOf = (xml: string) => /<Code>([A-Za-z0-9._-]{1,64})<\/Code>/.exec(xml)?.[1];

export class R2FileStorage implements FileStorage {
  readonly provider = 'r2';
  private readonly transport: typeof http | typeof https;
  private readonly agent: http.Agent;
  private readonly host: string;
  private readonly now: () => Date;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: R2Options) {
    const { endpoint } = options;
    this.transport = endpoint.protocol === 'https:' ? https : http;
    this.agent = new this.transport.Agent({ keepAlive: true, maxSockets: 50 });
    this.host = endpoint.host; // includes a non-default port, exactly as the Host header carries it
    this.now = options.now ?? (() => new Date());
    this.retries = options.retries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 200;
  }

  private objectPath(key: string): string {
    return `/${this.options.bucket}/${assertStorageKey(key)}`;
  }

  /** One signed request; transient failures are retried. `body` makes a fresh stream per attempt. */
  private async send(
    operation: string,
    request: {
      method: string;
      path: string;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      body?: () => Readable;
      payloadHash?: string;
    },
  ): Promise<Answer> {
    for (let attempt = 0; ; attempt++) {
      try {
        const answer = await this.once(request);
        if (TRANSIENT.has(answer.status) && attempt < this.retries) {
          answer.body.resume();
          await sleep(this.retryDelayMs * 4 ** attempt);
          continue;
        }
        return answer;
      } catch (error) {
        if (error instanceof StorageUnavailableError && attempt < this.retries) {
          await sleep(this.retryDelayMs * 4 ** attempt);
          continue;
        }
        if (error instanceof StorageUnavailableError) {
          throw new StorageUnavailableError(error.category, `storage ${operation} failed: ${error.category}`);
        }
        throw error;
      }
    }
  }

  private once(request: {
    method: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: () => Readable;
    payloadHash?: string;
  }): Promise<Answer> {
    const headers = signedHeaders(
      {
        method: request.method,
        host: this.host,
        path: request.path,
        query: request.query,
        headers: request.headers,
        payloadHash: request.payloadHash ?? EMPTY_SHA256,
      },
      this.options.credentials,
      { region: this.options.region, service: 's3' },
      this.now(),
    );
    const query = request.query && Object.keys(request.query).length ? `?${canonicalQuery(request.query)}` : '';
    return new Promise((resolve, reject) => {
      const outgoing = this.transport.request(
        {
          protocol: this.options.endpoint.protocol,
          hostname: this.options.endpoint.hostname,
          port: this.options.endpoint.port || undefined,
          method: request.method,
          path: `${encodePath(request.path)}${query}`,
          headers,
          agent: this.agent,
          timeout: this.options.timeoutMs,
        },
        (response) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }),
      );
      outgoing.once('timeout', () => outgoing.destroy(new StorageUnavailableError('timeout', 'storage timed out')));
      outgoing.once('error', (error) =>
        reject(
          error instanceof StorageUnavailableError
            ? error
            : new StorageUnavailableError('unreachable', 'storage unreachable'),
        ),
      );
      if (request.body) {
        const body = request.body();
        body.once('error', (error) => outgoing.destroy(error));
        body.pipe(outgoing);
      } else {
        outgoing.end();
      }
    });
  }

  /** Any answer other than the expected ones, as a StorageUnavailableError naming the provider's code. */
  private async refused(operation: string, answer: Answer): Promise<StorageUnavailableError> {
    const code = errorCodeOf(await readText(answer.body, MAX_ERROR_BODY).catch(() => ''));
    const category =
      answer.status === 401 || answer.status === 403
        ? 'credentials'
        : answer.status >= 500 || answer.status === 429
          ? 'provider_error'
          : 'unexpected_response';
    return new StorageUnavailableError(
      category,
      `storage ${operation} answered ${answer.status}${code ? ` ${code}` : ''}`,
    );
  }

  async stage(source: Readable, limits: StageLimits): Promise<StagedObject> {
    const staged = await stageToFile(this.options.stagingDir, source, limits);
    return {
      sizeBytes: staged.sizeBytes,
      sha256: staged.sha256,
      promote: async (key: string, metadata?: ObjectMetadata) => {
        const answer = await this.send('put', {
          method: 'PUT',
          path: this.objectPath(key),
          headers: {
            'content-length': String(staged.sizeBytes),
            'content-type': metadata?.contentType ?? 'application/octet-stream',
          },
          body: () => createReadStream(staged.path),
          payloadHash: staged.sha256,
        });
        if (answer.status !== 200) throw await this.refused('put', answer);
        answer.body.resume();
        await rm(staged.path, { force: true });
      },
      discard: () => rm(staged.path, { force: true }),
    };
  }

  async get(key: string): Promise<{ stream: Readable; sizeBytes: number }> {
    const answer = await this.send('get', { method: 'GET', path: this.objectPath(key) });
    if (answer.status === 404) {
      answer.body.resume();
      throw new StorageNotFoundError('object missing');
    }
    if (answer.status !== 200) throw await this.refused('get', answer);
    return { stream: answer.body, sizeBytes: Number(answer.headers['content-length'] ?? 0) };
  }

  async head(key: string): Promise<{ sizeBytes: number } | undefined> {
    const answer = await this.send('head', { method: 'HEAD', path: this.objectPath(key) });
    answer.body.resume();
    if (answer.status === 404) return undefined;
    if (answer.status !== 200) throw await this.refused('head', answer);
    return { sizeBytes: Number(answer.headers['content-length'] ?? 0) };
  }

  async delete(key: string): Promise<void> {
    const answer = await this.send('delete', { method: 'DELETE', path: this.objectPath(key) });
    if (answer.status === 204 || answer.status === 200 || answer.status === 404) {
      answer.body.resume();
      return;
    }
    throw await this.refused('delete', answer);
  }

  /** Every object in the bucket (ListObjectsV2, 1000 a page): what R2 stores, and so what it bills. */
  async usage(): Promise<{ bytes: number; objects: number }> {
    let bytes = 0;
    let objects = 0;
    let token: string | undefined;
    for (let page = 0; page < 100_000; page++) {
      const answer = await this.send('list', {
        method: 'GET',
        path: `/${this.options.bucket}`,
        query: { 'list-type': '2', 'max-keys': '1000', ...(token ? { 'continuation-token': token } : {}) },
      });
      if (answer.status !== 200) throw await this.refused('list', answer);
      const xml = await readText(answer.body);
      for (const match of xml.matchAll(/<Contents>[\s\S]*?<Size>(\d+)<\/Size>[\s\S]*?<\/Contents>/g)) {
        bytes += Number(match[1]);
        objects += 1;
      }
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return { bytes, objects };
      token = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
      if (!token)
        throw new StorageUnavailableError('unexpected_response', 'storage list answered without a continuation');
    }
    throw new StorageUnavailableError('unexpected_response', 'storage list did not end');
  }

  sweepStaging(olderThanMs: number): Promise<number> {
    return sweepDirectory(this.options.stagingDir, olderThanMs);
  }

  /**
   * A presigned GET for one object, valid `expiresInSeconds`. The response headers are part of the signature, so the
   * link serves the bytes as the service decided (type, disposition, never cached) and cannot be bent to another key.
   */
  signedReadUrl(key: string, options: SignedReadOptions): string {
    return presignedUrl(
      {
        method: 'GET',
        protocol: this.options.endpoint.protocol === 'https:' ? 'https:' : 'http:',
        host: this.host,
        path: this.objectPath(key),
        query: {
          'response-content-type': options.contentType,
          'response-content-disposition': options.contentDisposition,
          'response-cache-control': 'private, no-store',
        },
      },
      this.options.credentials,
      { region: this.options.region, service: 's3' },
      this.now(),
      options.expiresInSeconds,
    );
  }

  /** Closes idle keep-alive connections (shutdown). */
  close(): void {
    this.agent.destroy();
  }
}
