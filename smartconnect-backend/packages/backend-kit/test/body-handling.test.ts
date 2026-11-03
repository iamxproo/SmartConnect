import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { hasPathEscape, isFileContentUpload, rejectPathEscapes, requireJsonBodies } from '../src/http/body-handling.js';

const ORG = '019a4a00-0000-7000-8000-000000000001';
const FILE = '019a4a00-0000-7000-8000-000000000002';
const req = (method: string, path: string, contentType = 'application/octet-stream') =>
  ({
    method,
    path,
    originalUrl: path,
    id: 'request-1',
    headers: { 'content-length': '10', 'content-type': contentType },
    is: (types: string[]) => types.some((type) => type === contentType),
  }) as unknown as Request;

describe('isFileContentUpload', () => {
  it('matches exactly PUT /api/v1/orgs/{org}/files/{file}/content', () => {
    expect(isFileContentUpload(req('PUT', `/api/v1/orgs/${ORG}/files/${FILE}/content`))).toBe(true);
    expect(isFileContentUpload(req('PUT', `/api/v1/orgs/${ORG}/files/${FILE}/content/`))).toBe(true);
  });

  it.each([
    ['GET', `/api/v1/orgs/${ORG}/files/${FILE}/content`],
    ['POST', `/api/v1/orgs/${ORG}/files/${FILE}/content`],
    ['PUT', `/api/v1/orgs/${ORG}/files/${FILE}`],
    ['PUT', `/api/v1/orgs/${ORG}/files/${FILE}/content/more`],
    ['PUT', `/api/v1/orgs/${ORG}/files/${FILE}/content2`],
    ['PUT', `/api/v1/orgs/${ORG}/workspaces/${FILE}/content`],
    ['PUT', `/api/v1/orgs/${ORG}/files//content`],
    ['PUT', `/api/v1/orgs/a/b/files/${FILE}/content`],
    ['PUT', `/x/api/v1/orgs/${ORG}/files/${FILE}/content`],
    ['PUT', `/api/v1/orgs/${ORG}/files/${FILE}/content/../x`],
  ])('rejects %s %s', (method, path) => {
    expect(isFileContentUpload(req(method, path))).toBe(false);
  });
});

describe('requireJsonBodies with a raw-body exemption', () => {
  const run = (request: Request, exempt?: (r: Request) => boolean) => {
    const next: NextFunction = vi.fn();
    const status = vi.fn().mockReturnThis();
    const res = { status, type: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    requireJsonBodies('https://e/', exempt)(request, res, next);
    return { next, status };
  };

  it('still refuses non-JSON bodies by default', () => {
    const { next, status } = run(req('PUT', '/api/v1/anything'));
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(415);
  });

  it('lets only the exempted request through', () => {
    const upload = req('PUT', `/api/v1/orgs/${ORG}/files/${FILE}/content`);
    expect(run(upload, isFileContentUpload).next).toHaveBeenCalled();
    const other = run(req('PUT', `/api/v1/orgs/${ORG}/files/${FILE}`), isFileContentUpload);
    expect(other.next).not.toHaveBeenCalled();
    expect(other.status).toHaveBeenCalledWith(415);
  });
});

describe('hasPathEscape / rejectPathEscapes', () => {
  it.each([
    '/api/v1/orgs/o/files/%2e%2e/files',
    '/api/v1/orgs/o/files/%2E%2e/files',
    '/api/v1/orgs/o/files/..%2ffiles',
    '/api/v1/orgs/o/files/%5cx',
    '/api/v1/orgs/o/files/../files',
    '/api/v1/orgs/o/files/./x',
    '/api/v1/orgs/o/files/..',
    '/api/v1/orgs/o\\files',
  ])('flags %s', (url) => {
    expect(hasPathEscape(url)).toBe(true);
  });

  it.each([
    '/api/v1/orgs/o/files/f/content',
    '/api/v1/orgs/o/files?q=%2e%2e&x=../y',
    '/api/v1/orgs/o/files/a..b',
    '/health/live',
  ])('allows %s', (url) => {
    expect(hasPathEscape(url)).toBe(false);
  });

  it('answers 400 and never reaches routing', () => {
    const next: NextFunction = vi.fn();
    const status = vi.fn().mockReturnThis();
    const res = { status, type: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    rejectPathEscapes('https://e/')(req('POST', '/api/v1/orgs/o/files/%2e%2e/files'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(400);
  });
});
