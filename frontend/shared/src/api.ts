export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** A failed API call. Messages are written for people; `fieldErrors` maps form fields to problems. */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: unknown;
  readonly fieldErrors: Record<string, string>;

  constructor(status: number, detail: unknown, message: string, fieldErrors: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.fieldErrors = fieldErrors;
  }
}

/** Both FastAPI and the Node service report `{ detail: string | [{ loc, msg }] }`. */
export function readDetail(status: number, detail: unknown): ApiError {
  if (typeof detail === 'string') return new ApiError(status, detail, detail);
  if (Array.isArray(detail)) {
    const fieldErrors: Record<string, string> = {};
    let first = '';
    for (const issue of detail as Array<{ loc?: unknown[]; msg?: string }>) {
      const msg = issue?.msg ?? 'Invalid value';
      const field = Array.isArray(issue?.loc) ? String(issue.loc[issue.loc.length - 1] ?? '') : '';
      if (field && !(field in fieldErrors)) fieldErrors[field] = msg;
      first ||= field ? `${field}: ${msg}` : msg;
    }
    return new ApiError(status, detail, first || 'The request was not valid', fieldErrors);
  }
  const fallback: Record<number, string> = {
    400: 'The request was not valid.',
    401: 'Please sign in again.',
    403: 'You do not have access to this.',
    404: 'Not found.',
    429: 'Too many requests. Wait a moment and try again.',
    503: 'The service is temporarily unavailable. Try again in a moment.',
  };
  return new ApiError(status, detail, fallback[status] ?? `Something went wrong (HTTP ${status}).`);
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  headers?: Record<string, string>;
  /** "none" never sends the token and never tries to refresh (login, register, public reads). */
  auth?: 'required' | 'none';
}

export interface RawResponse<T> {
  status: number;
  headers: Headers;
  data: T;
}

type Listener = () => void;

/**
 * Small fetch wrapper that owns the session:
 *  - The access token lives in memory only (never localStorage), so it cannot be read by injected scripts later.
 *  - The refresh token is an httpOnly cookie the browser sends to /api/users/refresh by itself.
 *  - A 401 triggers ONE refresh shared by every request that failed at the same time, then a single retry.
 */
export function createApiClient({ baseUrl = '', fetchImpl }: ApiClientOptions = {}) {
  const doFetch: typeof fetch = (...args) => (fetchImpl ?? fetch)(...args);
  let accessToken: string | null = null;
  let refreshing: Promise<string | null> | null = null;
  const lostListeners = new Set<Listener>();

  function url(path: string, query?: RequestOptions['query']): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  async function send(method: string, path: string, options: RequestOptions, token: string | null) {
    const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token && options.auth !== 'none') headers.Authorization = `Bearer ${token}`;
    try {
      return await doFetch(url(path, options.query), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: 'include',
      });
    } catch {
      throw new ApiError(0, null, 'Cannot reach the server. Check your connection and try again.');
    }
  }

  async function refresh(): Promise<string | null> {
    // Every caller waiting on a refresh shares the same request: refresh tokens are single-use,
    // so two parallel refreshes would make the second one look like a replay attack.
    refreshing ??= (async () => {
      try {
        const response = await send('POST', '/api/users/refresh', { auth: 'none' }, null);
        if (!response.ok) return null;
        const body = (await response.json()) as { access_token?: string };
        accessToken = body.access_token ?? null;
        return accessToken;
      } catch {
        return null;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function requestRaw<T>(method: string, path: string, options: RequestOptions = {}): Promise<RawResponse<T>> {
    let response = await send(method, path, options, accessToken);
    if (response.status === 401 && options.auth !== 'none') {
      const renewed = await refresh();
      if (renewed) {
        response = await send(method, path, options, renewed);
      } else {
        accessToken = null;
        lostListeners.forEach((listener) => listener());
      }
    }
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const detail = data && typeof data === 'object' && 'detail' in data ? (data as { detail: unknown }).detail : data;
      throw readDetail(response.status, detail);
    }
    return { status: response.status, headers: response.headers, data: data as T };
  }

  return {
    request: async <T>(method: string, path: string, options?: RequestOptions) =>
      (await requestRaw<T>(method, path, options)).data,
    requestRaw,
    refresh,
    getToken: () => accessToken,
    setToken: (token: string | null) => {
      accessToken = token;
    },
    /** Called when a request failed with 401 and the session could not be renewed. */
    onSessionLost: (listener: Listener) => {
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
