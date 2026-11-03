export interface FieldError {
  field: string;
  code: string;
  message: string;
}

interface Problem {
  code?: unknown;
  title?: unknown;
  detail?: unknown;
  requestId?: unknown;
  errors?: unknown;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** An RFC 9457 problem+json response from the API. Branch on `code`, never on the message. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly errors: FieldError[];
  readonly requestId: string | undefined;

  constructor(status: number, problem: Problem = {}, headerRequestId?: string) {
    super(text(problem.detail) ?? text(problem.title) ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = text(problem.code) ?? 'unknown_error';
    this.detail = text(problem.detail);
    this.errors = Array.isArray(problem.errors) ? (problem.errors as FieldError[]) : [];
    this.requestId = text(problem.requestId) ?? headerRequestId;
  }
}

export async function readApiError(response: Response): Promise<ApiError> {
  let problem: Problem = {};
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object') problem = body;
  } catch {
    // Not JSON (proxy error page, empty body): the status alone describes it.
  }
  return new ApiError(response.status, problem, response.headers.get('X-Request-Id') ?? undefined);
}
